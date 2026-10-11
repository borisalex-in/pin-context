import * as vscode from 'vscode';
import * as path from 'path';
import { t } from '../l10n';
import { ContextSnapshot, ContextTimelineEntry, PinContext } from '../types';
import { GitBranchChange, GitContextService } from '../services/gitContextService';
import { PinStore } from './pinStore';
import { OperationQueue } from '../core/operationQueue';
import { ContextPersistenceService } from '../services/contextPersistenceService';
import { ContextFileService } from '../services/contextFileService';
import { ContextSyncService } from '../services/contextSyncService';
import { WorkingSetService } from '../services/workingSetService';
import { logger } from '../utils/logger';

type ContextConfigSchema = {
  'contexts.autoGitContexts': boolean;
  'contexts.restoreLastContext': boolean;
  'contexts.timelineEnabled': boolean;
  'contexts.maxTimelineEntries': number;
  'contexts.autoSwitchOnGitBranchChange': boolean;
  'contexts.repoContextsFile': boolean;
};

const SYNC_DEBOUNCE_MS = 150;
const BRANCH_CACHE_TTL_MS = 60000;

const gitContextId = (folder: string, branch: string): string => `git:${folder}:${branch}`;

export class ContextStore implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  /** Fired once when contexts of deleted branches are discovered (the UI offers a cleanup). */
  private readonly onDidFindStaleContextsEmitter = new vscode.EventEmitter<void>();
  readonly onDidFindStaleContexts = this.onDidFindStaleContextsEmitter.event;

  private readonly disposables: vscode.Disposable[] = [];

  private readonly operationQueue = new OperationQueue();
  private activeSwitchCts: vscode.CancellationTokenSource | undefined;
  /** Counts switches that are queued or running; pin tracking is suppressed meanwhile. */
  private pendingSwitches = 0;
  /**
   * True after a switch was cancelled or failed half-way: the current pins then do not
   * belong to the active context and must never be written back into it.
   */
  private pinsInconsistent = false;
  private syncTimer: NodeJS.Timeout | undefined;
  private refreshInFlight: Promise<void> | undefined;
  private refreshQueued = false;
  private timelineSeq = 0;
  private disposed = false;

  private readonly persistenceService: ContextPersistenceService;
  private readonly syncService: ContextSyncService;
  private readonly workingSet: WorkingSetService;
  readonly fileService: ContextFileService;

  private readonly contexts = new Map<string, PinContext>();
  private readonly staleContextIds = new Set<string>();
  private readonly branchCache = new Map<string, { value: string[]; at: number }>();
  private activeContextId: string | undefined;
  private lastActiveContextId: string | undefined;
  private timeline: ContextTimelineEntry[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly pinStore: PinStore,
    private readonly gitContextService: GitContextService
  ) {
    this.persistenceService = new ContextPersistenceService(context);
    this.syncService = new ContextSyncService(pinStore);
    this.workingSet = new WorkingSetService();
    this.fileService = new ContextFileService();

    this.disposables.push(
      this.pinStore.onDidChange(() => this.scheduleSyncFromPins()),
      this.gitContextService.onDidChangeBranch((event) => {
        void this.handleBranchChange(event).catch((error) =>
          logger.error('Failed to handle git branch change', error)
        );
      }),
      this.gitContextService.onDidChangeStatus(() => {
        void this.refreshGitContexts().catch((error) =>
          logger.error('Failed to refresh git contexts', error)
        );
      })
    );
  }

  async initialize(): Promise<void> {
    await this.load();
    this.watchRepoContextFile();
    // Wait until pins are restored, otherwise restoring a context would race with it.
    await this.pinStore.whenReady();
    await this.refreshRepoContexts();
    await this.refreshGitContexts();

    // On a fresh workspace there may be no persisted activeContextId yet. In that case,
    // seed the active context from the branch that is currently checked out and adopt the
    // pins already visible in the workbench. Without this, the first branch-change event
    // treats the new branch as the first active context and the original branch never owns
    // the pins that were created before the first switch.
    const restoreLastContext = this.getConfig('contexts.restoreLastContext', false);
    if (!this.activeContextId && (!restoreLastContext || !this.lastActiveContextId)) {
      await this.initializeActiveGitContext();
    }

    if (restoreLastContext) {
      // `lastActiveContextId` is the context *before* the active one; the one that was
      // active when the window closed is `activeContextId`.
      const restoreId = this.activeContextId ?? this.lastActiveContextId;
      if (restoreId && this.contexts.has(restoreId)) {
        await this.switchContext(restoreId, 'restore');
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = undefined;
    }
    this.disposables.forEach((d) => d.dispose());
    this.activeSwitchCts?.cancel();
    this.activeSwitchCts?.dispose();
    this.onDidChangeEmitter.dispose();
    this.onDidFindStaleContextsEmitter.dispose();
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  getActiveContext(): PinContext | undefined {
    return this.activeContextId ? this.contexts.get(this.activeContextId) : undefined;
  }

  getContextById(contextId: string): PinContext | undefined {
    return this.contexts.get(contextId);
  }

  /**
   * Git contexts of other workspaces (possible with `globalState` scope) are hidden:
   * switching to them would pin files from an unrelated repository.
   */
  getAllContexts(): PinContext[] {
    const folders = new Set((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
    return [...this.contexts.values()]
      .filter(
        (c) =>
          c.source === 'manual' ||
          (c.workspaceFolder !== undefined && folders.has(c.workspaceFolder))
      )
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  hasManualContextName(name: string, exceptId?: string): boolean {
    const normalized = name.trim().toLowerCase();
    return [...this.contexts.values()].some(
      (c) =>
        c.source === 'manual' && c.id !== exceptId && c.name.trim().toLowerCase() === normalized
    );
  }

  getTimelineBuckets(): {
    today: ContextTimelineEntry[];
    yesterday: ContextTimelineEntry[];
    older: ContextTimelineEntry[];
  } {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    // Calendar arithmetic instead of "- 24h", which is off by an hour around DST changes.
    const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();

    const today: ContextTimelineEntry[] = [];
    const yesterday: ContextTimelineEntry[] = [];
    const older: ContextTimelineEntry[] = [];

    for (const entry of this.timeline) {
      if (entry.timestamp >= todayStart) {
        today.push(entry);
      } else if (entry.timestamp >= yesterdayStart) {
        yesterday.push(entry);
      } else {
        older.push(entry);
      }
    }

    return { today, yesterday, older };
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  async createManualContext(name: string): Promise<PinContext | undefined> {
    const now = Date.now();
    const contextId = `manual:${now}:${Math.random().toString(36).slice(2, 8)}`;

    const created: PinContext = {
      id: contextId,
      name: name.trim(),
      source: 'manual',
      pinnedUris: this.syncService.getPinnedUriStrings(),
      createdAt: now,
      updatedAt: now
    };

    this.contexts.set(contextId, created);
    // Persist the new context before switching to it. If storage fails, do not leave a
    // context in memory that appears to have been created but would disappear on restart.
    if (!(await this.persist())) {
      this.contexts.delete(contextId);
      this.onDidChangeEmitter.fire();
      return undefined;
    }

    // The new context starts from the current pins, so this switch is a no-op for tabs.
    await this.switchContext(contextId, 'create');
    this.onDidChangeEmitter.fire();
    return created;
  }

  async saveCurrentPinsToContext(contextId: string): Promise<boolean> {
    const item = this.contexts.get(contextId);
    if (!item) {
      return false;
    }

    const before = cloneContext(item);
    const timelineBefore = [...this.timeline];
    item.pinnedUris = this.syncService.getPinnedUriStrings();
    this.applyWorkingSet(item);
    item.updatedAt = Date.now();
    this.pinsInconsistent = false;
    this.pushTimeline(contextId, item.name, 'save');

    // A repository context lives in the file, not in the state snapshot.
    if (item.source === 'repo') {
      if (!(await this.writeRepoContextFile(item))) {
        Object.assign(item, before);
        this.timeline = timelineBefore;
        return false;
      }
    } else {
      if (!(await this.persist())) {
        Object.assign(item, before);
        this.timeline = timelineBefore;
        return false;
      }
    }
    this.onDidChangeEmitter.fire();
    return true;
  }

  async renameContext(contextId: string, nextName: string): Promise<boolean> {
    const item = this.contexts.get(contextId);
    const name = nextName.trim();
    if (!item || !name || item.source === 'repo') {
      return false;
    }

    const oldName = item.name;
    const oldUpdatedAt = item.updatedAt;
    const timelineBefore = this.timeline;
    item.name = name;
    item.updatedAt = Date.now();
    // Keep history readable: old entries used to keep showing the previous name.
    this.timeline = this.timeline.map((entry) =>
      entry.contextId === contextId ? { ...entry, contextName: name } : entry
    );

    if (!(await this.persist())) {
      item.name = oldName;
      item.updatedAt = oldUpdatedAt;
      this.timeline = timelineBefore;
      return false;
    }
    this.onDidChangeEmitter.fire();
    return true;
  }

  async deleteContext(contextId: string): Promise<boolean> {
    const item = this.contexts.get(contextId);
    // Git and repository contexts are derived from other sources; deleting the copy in
    // memory would silently come back, so the UI refuses it instead.
    if (!item || item.source === 'repo') {
      return false;
    }
    if (!this.contexts.delete(contextId)) {
      return false;
    }

    const activeBefore = this.activeContextId;
    const lastActiveBefore = this.lastActiveContextId;
    const timelineBefore = this.timeline;

    if (this.activeContextId === contextId) {
      this.activeContextId = undefined;
    }
    if (this.lastActiveContextId === contextId) {
      this.lastActiveContextId = undefined;
    }

    this.timeline = this.timeline.filter((e) => e.contextId !== contextId);

    if (!(await this.persist())) {
      this.contexts.set(contextId, item);
      this.activeContextId = activeBefore;
      this.lastActiveContextId = lastActiveBefore;
      this.timeline = timelineBefore;
      return false;
    }
    this.onDidChangeEmitter.fire();
    return true;
  }

  /** Manual contexts only: git and repository contexts have their own owners. */
  getExportableContexts(): PinContext[] {
    return this.getAllContexts().filter((context) => context.source === 'manual');
  }

  async exportContexts(fileUri: vscode.Uri, selected?: PinContext[]): Promise<boolean> {
    const exportable = new Set(this.getExportableContexts().map((context) => context.id));
    const contexts = selected
      ? this.getAllContexts().filter(
          (context) => exportable.has(context.id) && selected.some((s) => s.id === context.id)
        )
      : this.getExportableContexts();
    if (contexts.length === 0) {
      return false;
    }
    return this.fileService.write(fileUri, contexts);
  }

  /**
   * Merges contexts from a JSON file. Names are the identity of a manual context, so an
   * existing one is refreshed instead of being duplicated.
   */
  async importContexts(
    fileUri: vscode.Uri
  ): Promise<{ added: number; updated: number; saved: boolean }> {
    const parsed = await this.fileService.read(fileUri);
    const result = { added: 0, updated: 0, saved: true };
    const now = Date.now();
    const before = new Map(
      [...this.contexts.entries()].map(([id, context]) => [id, cloneContext(context)])
    );

    for (const incoming of parsed) {
      const existing = [...this.contexts.values()].find(
        (context) =>
          context.source === 'manual' &&
          context.name.trim().toLowerCase() === incoming.name.trim().toLowerCase()
      );

      if (existing) {
        existing.pinnedUris = incoming.pinnedUris;
        existing.editorStates = incoming.editorStates;
        existing.openTabs = incoming.openTabs;
        existing.updatedAt = now;
        result.updated += 1;
        continue;
      }

      const id = `manual:${now}:${result.added}:${Math.random().toString(36).slice(2, 8)}`;
      this.contexts.set(id, {
        ...incoming,
        id,
        source: 'manual',
        workspaceFolder: undefined,
        branch: undefined,
        changed: undefined,
        staged: undefined,
        createdAt: now,
        updatedAt: now
      });
      result.added += 1;
    }

    if (result.added > 0 || result.updated > 0) {
      if (!(await this.persist())) {
        this.contexts.clear();
        for (const [id, context] of before) {
          this.contexts.set(id, context);
        }
        result.added = 0;
        result.updated = 0;
        result.saved = false;
        return result;
      }
      this.onDidChangeEmitter.fire();
    }
    return result;
  }

  /** Persists a repository context back into `.vscode/pin-contexts.json`. */
  private async writeRepoContextFile(target: PinContext): Promise<boolean> {
    const fileUri = this.fileService
      .repoFileUris()
      .find(
        (uri) =>
          target.workspaceFolder &&
          sameFsPath(path.dirname(path.dirname(uri.fsPath)), target.workspaceFolder)
      );
    if (!fileUri) {
      void vscode.window.showErrorMessage(t('Pin Context: repository context file not found'));
      return false;
    }

    const siblings = [...this.contexts.values()].filter(
      (context) => context.source === 'repo' && context.workspaceFolder === target.workspaceFolder
    );
    return this.fileService.write(fileUri, siblings);
  }

  async switchContext(
    contextId: string,
    action: 'switch' | 'restore' | 'create' = 'switch'
  ): Promise<boolean> {
    if (!this.contexts.has(contextId)) {
      return false;
    }

    this.activeSwitchCts?.cancel();
    this.activeSwitchCts?.dispose();
    const switchCts = new vscode.CancellationTokenSource();
    this.activeSwitchCts = switchCts;
    const token = switchCts.token;

    // Suppress from the moment of the call (not from the moment the queued job starts),
    // otherwise pin changes made by a switch could leak into the previously active context.
    this.pendingSwitches += 1;
    try {
      return await this.operationQueue.runExclusive(async () => {
        const target = this.contexts.get(contextId);
        if (!target || token.isCancellationRequested || this.disposed) {
          return false;
        }

        // Persist the latest pins of the context we are leaving.
        this.flushActiveContextFromPins();

        const { toUnpin, toPin } = this.syncService.buildPinDiff(target);
        const title = `Switching to ${target.name}`;
        logger.info(
          `[contexts] switch start action=${action} from=${this.activeContextId ?? 'none'} to=${target.id} ` +
            `savedPins=${target.pinnedUris.length} currentPins=${this.syncService.getPinnedUriStrings().length} ` +
            `toUnpin=${toUnpin.length} toPin=${toPin.length}`
        );

        if (toUnpin.length > 0 || toPin.length > 0) {
          this.pinsInconsistent = true;
        }

        if (!token.isCancellationRequested && toUnpin.length > 0) {
          let result = await this.pinStore.unpinUris(toUnpin, {
            showProgress: toUnpin.length > 15,
            title
          });
          logger.info(
            `[contexts] unpin result context=${target.id} success=${result.success} failed=${result.failed} skipped=${result.skipped}`
          );
          // VS Code tab activation can be transiently delayed while Git changes the workbench.
          // Retry the batch once; already-applied operations are safe no-ops on the next pass.
          if (result.failed > 0 && !token.isCancellationRequested) {
            logger.warn(
              `[contexts] retrying ${result.failed} failed unpin operation(s) for ${target.id}`
            );
            result = await this.pinStore.unpinUris(toUnpin, { showProgress: false, title });
            logger.info(
              `[contexts] unpin retry context=${target.id} success=${result.success} failed=${result.failed} skipped=${result.skipped}`
            );
          }
        }
        if (!token.isCancellationRequested && toPin.length > 0) {
          let result = await this.pinStore.pinUris(toPin, {
            showProgress: toPin.length > 15,
            title
          });
          logger.info(
            `[contexts] pin result context=${target.id} success=${result.success} failed=${result.failed} skipped=${result.skipped}`
          );
          if (result.failed > 0 && !token.isCancellationRequested) {
            logger.warn(
              `[contexts] retrying ${result.failed} failed pin operation(s) for ${target.id}`
            );
            result = await this.pinStore.pinUris(toPin, { showProgress: false, title });
            logger.info(
              `[contexts] pin retry context=${target.id} success=${result.success} failed=${result.failed} skipped=${result.skipped}`
            );
          }
        }

        if (token.isCancellationRequested) {
          return false;
        }

        this.pinsInconsistent = false;

        // Caret/scroll positions and the regular tabs of the target context. Runs after the
        // pins were applied, because a pinned editor has to exist before it can be restored.
        await this.workingSet.restore(target, token);

        this.setActive(target, action);
        logger.info(
          `[contexts] switch complete active=${this.activeContextId} savedPins=${target.pinnedUris.length} ` +
            `currentPins=${this.syncService.getPinnedUriStrings().length}`
        );

        await this.persist();
        this.onDidChangeEmitter.fire();
        return true;
      });
    } finally {
      this.pendingSwitches = Math.max(0, this.pendingSwitches - 1);
    }
  }

  async refreshGitContexts(): Promise<void> {
    if (!this.getConfig('contexts.autoGitContexts', true) || this.disposed) {
      return;
    }

    // Calls arrive from polling, quick picks and commands; coalesce them.
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.doRefreshGitContexts().finally(() => {
      this.refreshInFlight = undefined;
    });
    await this.refreshInFlight;

    if (this.refreshQueued) {
      this.refreshQueued = false;
      await this.refreshGitContexts();
    }
  }

  /**
   * Re-reads the contexts of `.vscode/pin-contexts.json`. They live in the repository, so
   * they are never written to the state snapshot — the file is their only storage.
   */
  async refreshRepoContexts(): Promise<void> {
    if (this.disposed) {
      return;
    }

    let loaded: PinContext[] = [];
    try {
      loaded = await this.fileService.loadRepoContexts();
    } catch (error) {
      logger.error('Failed to load repository contexts', error);
      return;
    }

    const nextIds = new Set(loaded.map((context) => context.id));
    let changed = false;

    for (const context of [...this.contexts.values()]) {
      if (context.source !== 'repo') {
        continue;
      }
      if (!nextIds.has(context.id)) {
        this.contexts.delete(context.id);
        if (this.activeContextId === context.id) {
          this.activeContextId = undefined;
        }
        if (this.lastActiveContextId === context.id) {
          this.lastActiveContextId = undefined;
        }
        changed = true;
      }
    }

    for (const context of loaded) {
      const existing = this.contexts.get(context.id);
      // Keep the live copy when nothing in the file changed, otherwise edits to the file
      // win over the state that was loaded at startup.
      if (existing && existing.updatedAt >= context.updatedAt && !this.disposed) {
        continue;
      }
      if (existing && JSON.stringify(existing) === JSON.stringify(context)) {
        continue;
      }
      this.contexts.set(context.id, context);
      changed = true;
    }

    if (!changed) {
      return;
    }

    this.timeline = this.timeline.filter((entry) => this.contexts.has(entry.contextId));
    this.onDidChangeEmitter.fire();
  }

  /** Reloads the repository contexts when the file is edited outside VS Code. */
  private watchRepoContextFile(): void {
    if (typeof vscode.workspace.createFileSystemWatcher !== 'function') {
      return;
    }

    const watcher = vscode.workspace.createFileSystemWatcher('**/.vscode/pin-contexts.json');
    const reload = (): void => {
      void this.refreshRepoContexts().catch((error) =>
        logger.error('Failed to reload repository contexts', error)
      );
    };
    this.disposables.push(watcher, watcher.onDidChange(reload), watcher.onDidCreate(reload));
    // Deletions are handled by the same path: the file simply yields no contexts.
    this.disposables.push(watcher.onDidDelete(reload));
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async doRefreshGitContexts(): Promise<void> {
    const gitContexts = await this.gitContextService.getCurrentWorkspaceGitContexts();
    const now = Date.now();
    let changed = false;
    const currentIdByFolder = new Map<string, string>();

    for (const git of gitContexts) {
      const id = gitContextId(git.workspaceFolder, git.branch);
      currentIdByFolder.set(git.workspaceFolder, id);
      const existing = this.contexts.get(id);

      if (
        existing &&
        existing.name === git.branch &&
        existing.changed === git.changed &&
        existing.staged === git.staged
      ) {
        continue;
      }

      this.contexts.set(id, {
        id,
        name: git.branch,
        source: 'git',
        workspaceFolder: git.workspaceFolder,
        branch: git.branch,
        changed: git.changed,
        staged: git.staged,
        pinnedUris: existing?.pinnedUris ?? [],
        createdAt: existing?.createdAt ?? now,
        updatedAt: existing?.updatedAt ?? now
      });
      changed = true;
    }

    // Branch contexts that were visited once and never got any pins would pile up forever.
    for (const ctx of [...this.contexts.values()]) {
      if (
        ctx.source === 'git' &&
        ctx.workspaceFolder &&
        currentIdByFolder.has(ctx.workspaceFolder) &&
        currentIdByFolder.get(ctx.workspaceFolder) !== ctx.id &&
        ctx.pinnedUris.length === 0 &&
        ctx.id !== this.activeContextId &&
        ctx.id !== this.lastActiveContextId
      ) {
        this.contexts.delete(ctx.id);
        changed = true;
      }
    }

    await this.markStaleGitContexts([...currentIdByFolder.keys()]);

    if (changed) {
      this.timeline = this.timeline.filter((entry) => this.contexts.has(entry.contextId));
    }

    if (!changed || this.disposed) {
      return;
    }
    await this.persist();
    this.onDidChangeEmitter.fire();
  }

  /**
   * Branches can be deleted while their context still holds pins. Such a context can never
   * be reached by a branch switch again, so it is reported to the user, who decides whether
   * the pins are still wanted. An unknown branch list means nothing: never delete on a guess.
   */
  private async markStaleGitContexts(folders: string[]): Promise<void> {
    const previous = this.staleContextIds.size;
    this.staleContextIds.clear();

    for (const folder of folders) {
      const branches = await this.knownBranches(folder);
      if (branches.length === 0) {
        continue;
      }
      const known = new Set(branches);

      for (const ctx of this.contexts.values()) {
        if (
          ctx.source !== 'git' ||
          ctx.workspaceFolder !== folder ||
          !ctx.branch ||
          // Detached HEAD is not a branch and is legitimately absent from `git branch`.
          ctx.branch.startsWith('detached') ||
          known.has(ctx.branch) ||
          ctx.id === this.activeContextId ||
          ctx.id === this.lastActiveContextId
        ) {
          continue;
        }
        this.staleContextIds.add(ctx.id);
      }
    }

    if (this.staleContextIds.size > 0 && previous === 0) {
      this.onDidFindStaleContextsEmitter.fire();
    }
  }

  /** Cached branch list per folder; refreshing it must not spawn git on every status event. */
  private async knownBranches(folder: string): Promise<string[]> {
    const cached = this.branchCache.get(folder);
    if (cached && Date.now() - cached.at < BRANCH_CACHE_TTL_MS) {
      return cached.value;
    }

    const branches = await this.gitContextService.getLocalBranches(folder);
    if (branches.length > 0) {
      this.branchCache.set(folder, { value: branches, at: Date.now() });
    }
    return branches;
  }

  /** Git contexts whose branch no longer exists in the repository. */
  getStaleContexts(): PinContext[] {
    return [...this.staleContextIds]
      .map((id) => this.contexts.get(id))
      .filter((context): context is PinContext => Boolean(context));
  }

  /** Drops the stale git contexts and returns how many were removed. */
  async removeStaleContexts(): Promise<number> {
    const ids = [...this.staleContextIds];
    const removedContexts = new Map<string, PinContext>();
    const activeBefore = this.activeContextId;
    const lastActiveBefore = this.lastActiveContextId;
    const timelineBefore = this.timeline;
    const staleBefore = new Set(this.staleContextIds);

    for (const id of ids) {
      const context = this.contexts.get(id);
      if (!context || !this.contexts.delete(id)) {
        continue;
      }
      removedContexts.set(id, context);
      if (this.activeContextId === id) {
        this.activeContextId = undefined;
      }
      if (this.lastActiveContextId === id) {
        this.lastActiveContextId = undefined;
      }
    }

    if (removedContexts.size === 0) {
      return 0;
    }

    this.staleContextIds.clear();
    this.timeline = this.timeline.filter((entry) => this.contexts.has(entry.contextId));
    if (!(await this.persist())) {
      for (const [id, context] of removedContexts) {
        this.contexts.set(id, context);
      }
      this.activeContextId = activeBefore;
      this.lastActiveContextId = lastActiveBefore;
      this.timeline = timelineBefore;
      for (const id of staleBefore) {
        this.staleContextIds.add(id);
      }
      return 0;
    }

    this.onDidChangeEmitter.fire();
    return removedContexts.size;
  }

  private async initializeActiveGitContext(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length === 0) {
      return;
    }

    const gitContexts = await this.gitContextService.getCurrentWorkspaceGitContexts();
    for (const folder of workspaceFolders) {
      const git = gitContexts.find((item) => item.workspaceFolder === folder.uri.fsPath);
      if (!git) {
        continue;
      }

      const id = gitContextId(git.workspaceFolder, git.branch);
      const context = this.contexts.get(id);
      if (!context) {
        continue;
      }

      logger.info(
        `[contexts] initialize active context=${id} existingPins=${context.pinnedUris.length}`
      );
      await this.adoptCurrentPins(context);
      return;
    }
  }

  private async handleBranchChange(event: GitBranchChange): Promise<void> {
    await this.refreshGitContexts();

    if (!this.getConfig('contexts.autoSwitchOnGitBranchChange', true)) {
      return;
    }

    const id = gitContextId(event.workspaceFolder, event.newBranch);
    const target = this.contexts.get(id);
    logger.info(
      `[contexts] branch change old=${event.oldBranch} new=${event.newBranch} active=${this.activeContextId ?? 'none'} ` +
        `targetExists=${Boolean(target)} targetPins=${target?.pinnedUris.length ?? -1}`
    );
    if (!target || this.activeContextId === id) {
      return;
    }

    if (target.pinnedUris.length === 0) {
      // A branch seen for the first time has no saved tabs. Wiping the user's pins
      // because they ran `git checkout -b` would be destructive, so carry them over.
      await this.adoptCurrentPins(target);
      return;
    }

    await this.switchContext(id, 'switch');
  }

  private async adoptCurrentPins(target: PinContext): Promise<void> {
    this.pendingSwitches += 1;
    try {
      await this.operationQueue.runExclusive(async () => {
        if (this.disposed || !this.contexts.has(target.id)) {
          return;
        }
        this.flushActiveContextFromPins();
        target.pinnedUris = this.syncService.getPinnedUriStrings();
        logger.info(
          `[contexts] adopt pins context=${target.id} inheritedPins=${target.pinnedUris.length} ` +
            `previousActive=${this.activeContextId ?? 'none'}`
        );
        // The context inherits whatever is on screen, so it inherits its layout too.
        this.applyWorkingSet(target);
        this.pinsInconsistent = false;
        this.setActive(target, 'switch');
        await this.persist();
        this.onDidChangeEmitter.fire();
      });
    } finally {
      this.pendingSwitches = Math.max(0, this.pendingSwitches - 1);
    }
  }

  private setActive(target: PinContext, action: 'switch' | 'restore' | 'create'): void {
    if (this.activeContextId !== target.id) {
      this.lastActiveContextId = this.activeContextId;
    }
    this.activeContextId = target.id;
    target.updatedAt = Date.now();
    this.pushTimeline(target.id, target.name, action);
  }

  private pushTimeline(
    contextId: string,
    contextName: string,
    action: ContextTimelineEntry['action']
  ): void {
    if (!this.getConfig('contexts.timelineEnabled', true)) {
      return;
    }

    const timestamp = Date.now();
    this.timeline.unshift({
      id: `${contextId}:${timestamp}:${action}:${this.timelineSeq++}`,
      contextId,
      contextName,
      action,
      timestamp
    });

    const max = Math.max(10, Number(this.getConfig('contexts.maxTimelineEntries', 100)) || 100);
    this.timeline = this.timeline.slice(0, max);
  }

  private async load(): Promise<void> {
    const snapshot = await this.persistenceService.load();
    if (!snapshot) {
      return;
    }

    this.contexts.clear();
    for (const c of snapshot.contexts) {
      this.contexts.set(c.id, c);
    }

    this.activeContextId =
      snapshot.activeContextId && this.contexts.has(snapshot.activeContextId)
        ? snapshot.activeContextId
        : undefined;
    this.lastActiveContextId =
      snapshot.lastActiveContextId && this.contexts.has(snapshot.lastActiveContextId)
        ? snapshot.lastActiveContextId
        : undefined;
    this.timeline = snapshot.timeline.filter((entry) => this.contexts.has(entry.contextId));
  }

  private async persist(): Promise<boolean> {
    const snapshot: ContextSnapshot = {
      // Repository contexts live in `.vscode/pin-contexts.json`; everything else (manual
      // and git contexts, which both own user pins) belongs to the state snapshot.
      contexts: [...this.contexts.values()].filter((context) => context.source !== 'repo'),
      activeContextId: this.activeContextId,
      lastActiveContextId: this.lastActiveContextId,
      timeline: this.timeline
    };

    return this.persistenceService.save(snapshot);
  }

  private getConfig<K extends keyof ContextConfigSchema>(
    key: K,
    fallback: ContextConfigSchema[K]
  ): ContextConfigSchema[K] {
    return vscode.workspace.getConfiguration('pin-context').get(key, fallback);
  }

  private scheduleSyncFromPins(): void {
    if (this.disposed || this.pendingSwitches > 0) {
      return;
    }
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      // Re-check at fire time: a switch may have started in the meantime.
      if (this.pendingSwitches > 0 || this.disposed) {
        return;
      }
      void this.syncActiveContextFromPins().catch((error) =>
        logger.error('Failed to sync active context', error)
      );
    }, SYNC_DEBOUNCE_MS);
  }

  /** Copies current pins into the active context. Returns true when something changed. */
  private flushActiveContextFromPins(): boolean {
    if (!this.activeContextId || this.pinsInconsistent) {
      return false;
    }

    const active = this.contexts.get(this.activeContextId);
    if (!active) {
      return false;
    }

    const next = this.syncService.getPinnedUriStrings();
    const prev = active.pinnedUris;
    const pinsChanged = !(prev.length === next.length && prev.every((v, i) => v === next[i]));
    const setChanged = this.applyWorkingSet(active);
    if (!pinsChanged && !setChanged) {
      return false;
    }

    active.pinnedUris = next;
    active.updatedAt = Date.now();
    return true;
  }

  /**
   * Stores the caret/scroll positions and the regular tabs of the context being left.
   * Cheap and synchronous, so a context always remembers the exact moment it was last used.
   */
  private applyWorkingSet(target: PinContext): boolean {
    const captured = this.workingSet.capture();

    const editorChanged = !isSameJson(target.editorStates ?? [], captured.editorStates ?? []);
    const tabsChanged = !isSameJson(target.openTabs ?? [], captured.openTabs ?? []);
    if (!editorChanged && !tabsChanged) {
      return false;
    }

    target.editorStates = captured.editorStates;
    target.openTabs = captured.openTabs;
    return true;
  }

  private async syncActiveContextFromPins(): Promise<void> {
    if (!this.flushActiveContextFromPins()) {
      return;
    }
    await this.persist();
    this.onDidChangeEmitter.fire();
  }
}

/** Deep equality for the small plain-data structures kept inside a context. */
function isSameJson(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function sameFsPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function cloneContext(context: PinContext): PinContext {
  return {
    ...context,
    pinnedUris: [...context.pinnedUris],
    editorStates: context.editorStates?.map((state) => ({ ...state })),
    openTabs: context.openTabs?.map((tab) => ({ ...tab }))
  };
}
