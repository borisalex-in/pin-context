import * as vscode from 'vscode';
import { ContextSnapshot, ContextTimelineEntry, PinContext } from '../types';
import { GitContextService } from '../services/gitContextService';
import { PinStore } from './pinStore';
import { OperationQueue } from '../core/operationQueue';
import { ContextPersistenceService } from '../services/contextPersistenceService';
import { ContextSyncService } from '../services/contextSyncService';

type ContextConfigSchema = {
  'contexts.autoGitContexts': boolean;
  'contexts.restoreLastContext': boolean;
  'contexts.timelineEnabled': boolean;
  'contexts.maxTimelineEntries': number;
  'contexts.autoSwitchOnGitBranchChange': boolean;
};

export class ContextStore implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private readonly pinStoreDisposable: vscode.Disposable;
  private gitBranchDisposable: vscode.Disposable;
  private gitStatusDisposable: vscode.Disposable;

  private readonly operationQueue = new OperationQueue();
  private suppressPinSync = 0;
  private activeSwitchCts: vscode.CancellationTokenSource | undefined;
  private readonly persistenceService: ContextPersistenceService;
  private readonly syncService: ContextSyncService;

  private readonly contexts = new Map<string, PinContext>();
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

    this.pinStoreDisposable = this.pinStore.onDidChange(() => {
      if (this.suppressPinSync > 0) return;
      void this.syncActiveContextFromPins();
    });

    this.gitBranchDisposable = this.gitContextService.onDidChangeBranch(async (event) => {
      const gitContextId = `git:${event.workspaceFolder}:${event.newBranch}`;
      await this.refreshGitContexts();

      const autoSwitch = this.getConfig('contexts.autoSwitchOnGitBranchChange', true);
      if (!autoSwitch) {
        return;
      }

      const target = this.contexts.get(gitContextId);
      if (target) {
        await this.switchContext(gitContextId, 'switch');
      }
    });

    /**
     * 🔥 ВАЖНО: теперь обновляем changed/staged
     */
    this.gitStatusDisposable = this.gitContextService.onDidChangeStatus?.(() => {
      void this.refreshGitContexts();
    });
  }

  async initialize(): Promise<void> {
    this.load();
    await this.refreshGitContexts();

    if (this.getConfig('contexts.restoreLastContext', true)) {
      const restoreId = this.lastActiveContextId ?? this.activeContextId;
      if (restoreId && this.contexts.has(restoreId)) {
        await this.switchContext(restoreId, 'restore');
      }
    }
  }

  dispose(): void {
    this.pinStoreDisposable.dispose();
    this.gitBranchDisposable.dispose();
    this.gitStatusDisposable?.dispose();
    this.activeSwitchCts?.cancel();
    this.activeSwitchCts?.dispose();
    this.onDidChangeEmitter.dispose();
  }

  getActiveContext(): PinContext | undefined {
    return this.activeContextId ? this.contexts.get(this.activeContextId) : undefined;
  }

  getAllContexts(): PinContext[] {
    return [...this.contexts.values()].sort((a, b) =>
      a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
    );
  }

  getTimelineBuckets(): {
    today: ContextTimelineEntry[];
    yesterday: ContextTimelineEntry[];
    older: ContextTimelineEntry[];
  } {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;

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

  async createManualContext(name: string): Promise<PinContext> {
    const now = Date.now();
    const contextId = `manual:${now}`;
    const pinnedUris = this.syncService.getPinnedUriStrings();

    const created: PinContext = {
      id: contextId,
      name,
      source: 'manual',
      pinnedUris,
      createdAt: now,
      updatedAt: now
    };

    this.contexts.set(contextId, created);
    this.pushTimeline(contextId, name, 'create');

    await this.switchContext(contextId, 'switch');
    await this.persist();

    this.onDidChangeEmitter.fire();
    return created;
  }

  async saveCurrentPinsToContext(contextId: string): Promise<void> {
    const item = this.contexts.get(contextId);
    if (!item) return;

    item.pinnedUris = this.syncService.getPinnedUriStrings();
    item.updatedAt = Date.now();

    this.contexts.set(contextId, item);
    this.pushTimeline(contextId, item.name, 'save');

    await this.persist();
    this.onDidChangeEmitter.fire();
  }

  async renameContext(contextId: string, nextName: string): Promise<boolean> {
    const item = this.contexts.get(contextId);
    if (!item) return false;

    const name = nextName.trim();
    if (!name) return false;

    item.name = name;
    item.updatedAt = Date.now();

    this.contexts.set(contextId, item);

    await this.persist();
    this.onDidChangeEmitter.fire();
    return true;
  }

  async deleteContext(contextId: string): Promise<boolean> {
    const item = this.contexts.get(contextId);
    if (!item) return false;

    this.contexts.delete(contextId);

    if (this.activeContextId === contextId) {
      this.activeContextId = undefined;
    }
    if (this.lastActiveContextId === contextId) {
      this.lastActiveContextId = undefined;
    }

    this.timeline = this.timeline.filter((e) => e.contextId !== contextId);

    await this.persist();
    this.onDidChangeEmitter.fire();
    return true;
  }

  async switchContext(
    contextId: string,
    action: 'switch' | 'restore' = 'switch'
  ): Promise<boolean> {
    const target = this.contexts.get(contextId);
    if (!target) return false;

    this.activeSwitchCts?.cancel();
    this.activeSwitchCts?.dispose();
    const switchCts = new vscode.CancellationTokenSource();
    this.activeSwitchCts = switchCts;

    return this.operationQueue.runExclusive(async () => {
      const token = switchCts.token;
      this.suppressPinSync += 1;

      try {
        const { toUnpin, toPin } = this.syncService.buildPinDiff(target);

        if (!token.isCancellationRequested && toUnpin.length > 0) {
          await this.pinStore.unpinUris(toUnpin, {
            showProgress: toUnpin.length > 15,
            title: `Switching to ${target.name}`
          });
        }

        if (!token.isCancellationRequested && toPin.length > 0) {
          await this.pinStore.pinUris(toPin, {
            showProgress: toPin.length > 15,
            title: `Switching to ${target.name}`
          });
        }
      } finally {
        this.suppressPinSync = Math.max(0, this.suppressPinSync - 1);
      }

      if (token.isCancellationRequested) {
        return false;
      }

      this.lastActiveContextId = this.activeContextId;
      this.activeContextId = contextId;

      target.updatedAt = Date.now();
      this.contexts.set(contextId, target);

      this.pushTimeline(contextId, target.name, action);

      await this.persist();
      this.onDidChangeEmitter.fire();

      return true;
    });
  }

  async refreshGitContexts(): Promise<void> {
    if (!this.getConfig('contexts.autoGitContexts', true)) return;

    const gitContexts = await this.gitContextService.getCurrentWorkspaceGitContexts();
    const now = Date.now();

    for (const git of gitContexts) {
      const id = `git:${git.workspaceFolder}:${git.branch}`;
      const existing = this.contexts.get(id);

      this.contexts.set(id, {
        id,
        name: `${git.branch}${
          git.changed || git.staged ? ` (changed: ${git.changed}, staged: ${git.staged})` : ''
        }`,
        source: 'git',
        workspaceFolder: git.workspaceFolder,
        branch: git.branch,
        pinnedUris: existing?.pinnedUris ?? [],
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      });
    }

    await this.persist();
    this.onDidChangeEmitter.fire();
  }

  private pushTimeline(
    contextId: string,
    contextName: string,
    action: ContextTimelineEntry['action']
  ): void {
    if (!this.getConfig('contexts.timelineEnabled', true)) return;

    this.timeline.unshift({
      id: `${contextId}:${Date.now()}:${action}`,
      contextId,
      contextName,
      action,
      timestamp: Date.now()
    });

    const max = this.getConfig('contexts.maxTimelineEntries', 100);
    this.timeline = this.timeline.slice(0, max);
  }

  private load(): void {
    const snapshot = this.persistenceService.load();
    if (!snapshot) return;

    this.contexts.clear();

    for (const c of snapshot.contexts) {
      this.contexts.set(c.id, c);
    }

    this.activeContextId = snapshot.activeContextId;
    this.lastActiveContextId = snapshot.lastActiveContextId;
    this.timeline = snapshot.timeline ?? [];
  }

  private async persist(): Promise<void> {
    const snapshot: ContextSnapshot = {
      contexts: this.getAllContexts(),
      activeContextId: this.activeContextId,
      lastActiveContextId: this.lastActiveContextId,
      timeline: this.timeline
    };

    await this.persistenceService.save(snapshot);
  }

  private getConfig<K extends keyof ContextConfigSchema>(
    key: K,
    fallback: ContextConfigSchema[K]
  ): ContextConfigSchema[K] {
    return vscode.workspace.getConfiguration('pin-context').get(key, fallback);
  }

  private async syncActiveContextFromPins(): Promise<void> {
    if (!this.activeContextId) return;

    const active = this.contexts.get(this.activeContextId);
    if (!active) return;

    const next = this.syncService.getPinnedUriStrings();
    const prev = active.pinnedUris;

    if (prev.length === next.length && prev.every((v, i) => v === next[i])) {
      return;
    }

    active.pinnedUris = next;
    active.updatedAt = Date.now();

    this.contexts.set(active.id, active);

    await this.persist();
    this.onDidChangeEmitter.fire();
  }
}
