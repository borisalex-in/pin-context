import * as vscode from 'vscode';
import { t } from '../l10n';
import { minimatch } from 'minimatch';
import { OperationQueue } from '../core/operationQueue';
import { logger } from '../utils/logger';
import {
  PinRecord,
  getPrimaryTabUri,
  isSameOrNested,
  isTrackableUri,
  parseUri,
  toPinRecord,
  toUriKey
} from '../utils/tabUtils';

const PERSISTED_PINS_KEY = 'pin-context.pinnedUris';
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_FIND_FILES_LIMIT = 2000;
const DEFAULT_RESTORE_REOPEN_LIMIT = 50;
const REFRESH_DEBOUNCE_MS = 25;
const ACTIVATION_TIMEOUT_MS = 1500;
const STATE_SETTLE_TIMEOUT_MS = 500;

type PersistenceScope = 'globalState' | 'workspaceState';
type RestoreBehavior = 'keepInTree' | 'reopenAndPin';

export interface BatchOutcome {
  success: number;
  failed: number;
  skipped: number;
  errors: string[];
}

export interface PinOptions {
  showProgress?: boolean;
  title?: string;
  /**
   * Open the file if it has no tab yet, so that it can be pinned.
   * Defaults to `true` only when `restoreBehavior` is `reopenAndPin`.
   * User-initiated commands pass `true`.
   */
  openIfClosed?: boolean;
}

interface UriResult {
  status: 'success' | 'failed' | 'skipped';
  error?: string;
  /** The file no longer exists (or is a folder): its record must be dropped. */
  missing?: boolean;
}

interface ActiveTabSnapshot {
  uri: vscode.Uri;
  viewColumn: vscode.ViewColumn;
}

const emptyOutcome = (): BatchOutcome => ({ success: 0, failed: 0, skipped: 0, errors: [] });

function isFileNotFound(error: unknown): boolean {
  if (error instanceof vscode.FileSystemError) {
    return error.code === 'FileNotFound' || /ENOENT|not found/i.test(error.message);
  }
  return /ENOENT|not found/i.test(error instanceof Error ? error.message : String(error));
}

export class PinStore implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly batchQueue = new OperationQueue();
  private readonly focusQueue = new OperationQueue();

  private refreshTimer: NodeJS.Timeout | undefined;
  private persistScheduled = false;
  private persistChain: Promise<void> = Promise.resolve();
  private persistErrorShown = false;
  private disposed = false;

  private applyingState = false;
  private refreshRequestedWhileApplying = false;

  private pinnedByKey = new Map<string, PinRecord>();
  /** Keys of files that had a pinned tab during the previous refresh. */
  private pinnedOpenKeys = new Set<string>();
  private cachedList: PinRecord[] = [];
  private cacheDirty = true;

  /**
   * Waiters resolved on the next tab-group change. Event-driven settling shortens the
   * window during which a tab other than the user's is active, reducing the visible
   * "flicker" of native pin/unpin batches.
   */
  private readonly tabChangeWaiters = new Set<() => void>();

  private readonly readyPromise: Promise<void>;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs(() => {
        this.notifyTabChange();
        this.scheduleRefresh();
      }),
      // Active-editor context keys follow tab focus. The Explorer's pinned-path map is also
      // refreshed here and whenever the pin set changes, keeping Pin/Unpin menu items in sync.
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.updateContextKeys()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContextKeys()),
      vscode.workspace.onDidDeleteFiles((event) => this.handleDeletedFiles(event.files)),
      vscode.workspace.onDidRenameFiles((event) => this.handleRenamedFiles(event.files)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('pin-context.persistenceScope')) {
          // Carry the in-memory state over to the newly selected storage scope.
          this.schedulePersist();
        }
      })
    );

    this.initializeFromPersistedState();
    this.refreshFromTabs(true);
    this.readyPromise = this.restorePinnedTabs().catch((error) => {
      logger.error('Failed to restore pinned tabs', error);
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.notifyTabChange();
    this.disposables.forEach((d) => d.dispose());
    this.onDidChangeEmitter.dispose();
  }

  /** Resolves once the startup restore finished (never rejects). */
  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  getPinnedCount(): number {
    return this.pinnedByKey.size;
  }

  getPinnedItems(): PinRecord[] {
    if (this.cacheDirty) {
      this.cachedList = [...this.pinnedByKey.values()].sort((a, b) => {
        if (a.folder !== b.folder) {
          return a.folder.localeCompare(b.folder);
        }
        return a.label.localeCompare(b.label);
      });
      this.cacheDirty = false;
    }
    return this.cachedList;
  }

  getPinnedUris(): vscode.Uri[] {
    return this.getPinnedItems().map((item) => item.uri);
  }

  isUriPinned(uri: vscode.Uri): boolean {
    return this.pinnedByKey.has(toUriKey(uri));
  }

  /**
   * Pinned in the UI sense: a pinned tab exists, or the file is in the pin list even while
   * only a regular tab (or none) is open — exactly what `togglePin` would act on.
   */
  isPinned(uri: vscode.Uri): boolean {
    const key = toUriKey(uri);
    if (this.findTabs(uri).some((tab) => tab.isPinned)) {
      return true;
    }
    return this.pinnedByKey.has(key);
  }

  async pinCurrentEditor(): Promise<BatchOutcome> {
    const uri = this.getActiveUri();
    if (!uri) {
      void vscode.window.showWarningMessage(t('No active editor to pin'));
      return emptyOutcome();
    }
    return this.pinUris([uri], { openIfClosed: true });
  }

  async unpinCurrentEditor(): Promise<BatchOutcome> {
    const uri = this.getActiveUri();
    if (!uri) {
      void vscode.window.showWarningMessage(t('No active editor to unpin'));
      return emptyOutcome();
    }
    return this.unpinUris([uri]);
  }

  async togglePinCurrentEditor(): Promise<BatchOutcome> {
    const tab = this.getActiveTab();
    const uri = this.getActiveUri();
    if (!uri) {
      void vscode.window.showWarningMessage(t('No active editor'));
      return emptyOutcome();
    }
    const pinned = tab && getPrimaryTabUri(tab) ? tab.isPinned : this.isUriPinned(uri);
    return pinned ? this.unpinUris([uri]) : this.pinUris([uri], { openIfClosed: true });
  }

  async pinAllEditors(): Promise<BatchOutcome> {
    const targets = this.getOpenTabs()
      .filter((tab) => !tab.isPinned)
      .map((tab) => getPrimaryTabUri(tab))
      .filter((uri): uri is vscode.Uri => Boolean(uri));
    return this.pinUris(targets);
  }

  async unpinAllEditors(): Promise<BatchOutcome> {
    const targets = this.getOpenTabs()
      .filter((tab) => tab.isPinned)
      .map((tab) => getPrimaryTabUri(tab))
      .filter((uri): uri is vscode.Uri => Boolean(uri));
    return this.unpinUris(targets);
  }

  async pinEditorsByPattern(rawPattern: string): Promise<BatchOutcome> {
    const pattern = rawPattern.trim();
    if (!pattern) {
      return emptyOutcome();
    }

    let matchingKeys = new Set<string>();
    try {
      const matchingFiles = await vscode.workspace.findFiles(
        pattern,
        undefined,
        this.getFindFilesLimit()
      );
      matchingKeys = new Set(matchingFiles.map((uri) => toUriKey(uri)));
    } catch (error) {
      logger.warn(`findFiles failed for pattern "${pattern}": ${String(error)}`);
    }

    const matchesPattern = (uri: vscode.Uri): boolean => {
      if (matchingKeys.has(toUriKey(uri))) {
        return true;
      }
      const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
      const options = { nocase: true, dot: true };
      return minimatch(relative, pattern, options) || minimatch(uri.path, pattern, options);
    };

    const targets = this.getOpenTabs()
      .filter((tab) => !tab.isPinned)
      .map((tab) => getPrimaryTabUri(tab))
      .filter((uri): uri is vscode.Uri => Boolean(uri) && matchesPattern(uri as vscode.Uri));

    return this.pinUris(targets);
  }

  async unpinUri(uri: vscode.Uri): Promise<BatchOutcome> {
    return this.unpinUris([uri]);
  }

  async pinUris(uris: vscode.Uri[], options?: PinOptions): Promise<BatchOutcome> {
    return this.applyPinState(uris, true, options);
  }

  async unpinUris(uris: vscode.Uri[], options?: PinOptions): Promise<BatchOutcome> {
    return this.applyPinState(uris, false, options);
  }

  syncWithOpenTabs(): void {
    if (this.applyingState) {
      this.refreshRequestedWhileApplying = true;
      return;
    }
    this.refreshFromTabs();
  }

  // ---------------------------------------------------------------------------
  // Tab helpers
  // ---------------------------------------------------------------------------

  private getOpenTabs(): vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
  }

  private getActiveTab(): vscode.Tab | undefined {
    return vscode.window.tabGroups.activeTabGroup?.activeTab;
  }

  /** Works for text, notebook and custom editors (images, etc.), not only text editors. */
  private getActiveUri(): vscode.Uri | undefined {
    const tab = this.getActiveTab();
    const fromTab = tab ? getPrimaryTabUri(tab) : undefined;
    const uri = fromTab ?? vscode.window.activeTextEditor?.document.uri;
    return uri && isTrackableUri(uri) ? uri : undefined;
  }

  private findTabs(uri: vscode.Uri): vscode.Tab[] {
    const key = toUriKey(uri);
    return this.getOpenTabs().filter((tab) => {
      const tabUri = getPrimaryTabUri(tab);
      return tabUri ? toUriKey(tabUri) === key : false;
    });
  }

  private isActiveWithState(uri: vscode.Uri, shouldPin: boolean): boolean {
    const tab = this.getActiveTab();
    if (!tab) {
      return false;
    }
    const tabUri = getPrimaryTabUri(tab);
    return (
      Boolean(tabUri) &&
      toUriKey(tabUri as vscode.Uri) === toUriKey(uri) &&
      tab.isPinned !== shouldPin
    );
  }

  private captureActiveTab(): ActiveTabSnapshot | undefined {
    const tab = this.getActiveTab();
    const uri = tab ? getPrimaryTabUri(tab) : undefined;
    if (!tab || !uri || !isTrackableUri(uri)) {
      return undefined;
    }
    return { uri, viewColumn: tab.group.viewColumn };
  }

  private async restoreActiveTab(
    original: ActiveTabSnapshot | undefined,
    touched: boolean
  ): Promise<void> {
    if (!original || !touched) {
      return;
    }
    const current = this.getActiveTab();
    const currentUri = current ? getPrimaryTabUri(current) : undefined;
    if (currentUri && toUriKey(currentUri) === toUriKey(original.uri)) {
      return;
    }
    try {
      await vscode.commands.executeCommand('vscode.open', original.uri, {
        viewColumn: original.viewColumn,
        preview: false
      });
    } catch (error) {
      logger.debug(`Could not restore active editor: ${String(error)}`);
    }
  }

  private async waitFor(
    condition: () => boolean,
    timeoutMs: number,
    stepMs = 20
  ): Promise<boolean> {
    if (condition()) {
      return true;
    }

    // Resolve as soon as the tab model changes instead of polling the full timeout.
    // The interval is only a safety net for missed events.
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (result: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        clearInterval(intervalHandle);
        this.tabChangeWaiters.delete(onChange);
        resolve(result);
      };
      const onChange = (): void => finish(condition());
      const intervalHandle = setInterval(() => {
        if (condition()) {
          finish(true);
        }
      }, stepMs);
      const timeoutHandle = setTimeout(() => finish(condition()), timeoutMs);
      this.tabChangeWaiters.add(onChange);
    });
  }

  private notifyTabChange(): void {
    for (const waiter of [...this.tabChangeWaiters]) {
      waiter();
    }
  }

  // ---------------------------------------------------------------------------
  // Syncing with the tab model
  // ---------------------------------------------------------------------------

  private scheduleRefresh(): void {
    if (this.disposed) {
      return;
    }
    if (this.applyingState) {
      this.refreshRequestedWhileApplying = true;
      return;
    }
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.applyingState) {
        this.refreshRequestedWhileApplying = true;
        return;
      }
      this.refreshFromTabs();
    }, REFRESH_DEBOUNCE_MS);
  }

  private refreshFromTabs(forceEmit = false): void {
    // A file can be open in several tabs (split view). It is "pinned" if any of them is.
    const openState = new Map<string, { uri: vscode.Uri; pinned: boolean }>();
    for (const tab of this.getOpenTabs()) {
      const uri = getPrimaryTabUri(tab);
      if (!uri || !isTrackableUri(uri)) {
        continue;
      }
      const key = toUriKey(uri);
      const previous = openState.get(key);
      openState.set(key, { uri, pinned: tab.isPinned || (previous?.pinned ?? false) });
    }

    const next = new Map(this.pinnedByKey);
    const nextPinnedOpen = new Set<string>();

    for (const [key, state] of openState) {
      if (state.pinned) {
        nextPinnedOpen.add(key);
        if (!next.has(key)) {
          next.set(key, toPinRecord(state.uri));
        }
      } else if (this.pinnedOpenKeys.has(key)) {
        // The tab used to be pinned and is not anymore: the user unpinned it.
        // A tracked file that is merely re-opened as a regular tab keeps its record.
        next.delete(key);
      }
    }
    this.pinnedOpenKeys = nextPinnedOpen;

    const changed = this.didPinnedSetChange(next);
    if (!changed && !forceEmit) {
      return;
    }

    this.pinnedByKey = next;
    this.cacheDirty = true;
    this.schedulePersist();
    this.updateContextKeys();
    this.onDidChangeEmitter.fire();
  }

  /**
   * Exposes the state of the active tab to `when` clauses (`pin-context.isPinned`,
   * `pin-context.hasActiveEditor`), so the Explorer/editor menus show a single contextual
   * pin command instead of Pin / Unpin / Toggle side by side.
   */
  updateContextKeys(): void {
    const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    const uri = activeTab ? getPrimaryTabUri(activeTab) : undefined;
    const trackable = uri !== undefined && isTrackableUri(uri);

    // Explorer context menus expose the selected URI through `resource` and its local path
    // through `resourcePath`. Match both representations: the full URI is canonical for the
    // context key, while the path map remains as a compatibility fallback.
    const pinnedResources = new Set<string>();
    const pinnedResourcePaths: Record<string, true> = {};
    for (const pinnedUri of this.getPinnedUris()) {
      if (pinnedUri.scheme !== 'file') {
        continue;
      }
      pinnedResources.add(pinnedUri.toString());
      pinnedResources.add(pinnedUri.toString(true));
      pinnedResourcePaths[pinnedUri.path] = true;
      pinnedResourcePaths[pinnedUri.fsPath] = true;
    }

    void vscode.commands.executeCommand('setContext', 'pin-context.pinnedResources', [
      ...pinnedResources
    ]);
    void vscode.commands.executeCommand(
      'setContext',
      'pin-context.pinnedResourcePaths',
      pinnedResourcePaths
    );
    void vscode.commands.executeCommand(
      'setContext',
      'pin-context.isPinned',
      trackable && this.isUriPinned(uri!)
    );
    void vscode.commands.executeCommand('setContext', 'pin-context.hasActiveEditor', trackable);
  }

  private didPinnedSetChange(next: Map<string, PinRecord>): boolean {
    if (next.size !== this.pinnedByKey.size) {
      return true;
    }
    for (const key of next.keys()) {
      if (!this.pinnedByKey.has(key)) {
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // File system events
  // ---------------------------------------------------------------------------

  private handleDeletedFiles(files: readonly vscode.Uri[]): void {
    const deletedKeys = files.map((uri) => toUriKey(uri));
    const affected = [...this.pinnedByKey.values()].filter((record) =>
      deletedKeys.some((deleted) => isSameOrNested(record.key, deleted))
    );
    if (affected.length > 0) {
      this.removePinnedRecords(affected.map((record) => record.uri));
    }
  }

  private handleRenamedFiles(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): void {
    let changed = false;
    const next = new Map(this.pinnedByKey);

    for (const { oldUri, newUri } of files) {
      const oldKey = toUriKey(oldUri);
      for (const record of [...next.values()]) {
        if (!isSameOrNested(record.key, oldKey)) {
          continue;
        }
        const suffix = record.uri.path.slice(oldUri.path.length);
        const movedUri = newUri.with({ path: newUri.path + suffix });
        next.delete(record.key);
        const movedRecord = toPinRecord(movedUri);
        next.set(movedRecord.key, movedRecord);
        changed = true;
      }
    }

    if (!changed) {
      return;
    }
    this.pinnedByKey = next;
    this.cacheDirty = true;
    this.schedulePersist();
    this.onDidChangeEmitter.fire();
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private schedulePersist(): void {
    if (this.persistScheduled || this.disposed) {
      return;
    }
    this.persistScheduled = true;
    // Writes are serialized, and each write snapshots the latest in-memory state.
    this.persistChain = this.persistChain.then(async () => {
      this.persistScheduled = false;
      const uris = [...this.pinnedByKey.values()].map((item) => item.uri.toString());
      try {
        await this.getPersistenceMemento().update(PERSISTED_PINS_KEY, uris);
      } catch (error) {
        logger.error('Failed to persist pinned URIs', error);
        if (!this.persistErrorShown) {
          this.persistErrorShown = true;
          void vscode.window.showErrorMessage(t('Pin Context: failed to save pinned files'));
        }
      }
    });
  }

  /**
   * Reads from the configured scope. When that scope has no pins key at all (not even an
   * empty array), the other scope is read once so data stored before the default changed
   * from `globalState` to `workspaceState` is not lost. The next persist writes to the
   * configured scope, which completes the migration.
   */
  private readPersistedUris(): vscode.Uri[] {
    const rawUris = this.readRawPersistedUris();
    if (!Array.isArray(rawUris)) {
      return [];
    }
    return rawUris
      .filter((value): value is string => typeof value === 'string')
      .map((value) => parseUri(value))
      .filter((uri): uri is vscode.Uri => Boolean(uri) && isTrackableUri(uri as vscode.Uri));
  }

  private readRawPersistedUris(): unknown {
    const scope = this.getPersistenceScope();
    const preferred = this.getMemento(scope).get<unknown>(PERSISTED_PINS_KEY);
    if (preferred !== undefined) {
      return preferred;
    }
    const fallbackScope: PersistenceScope =
      scope === 'workspaceState' ? 'globalState' : 'workspaceState';
    return this.getMemento(fallbackScope).get<unknown>(PERSISTED_PINS_KEY);
  }

  private initializeFromPersistedState(): void {
    this.replacePinnedRecords(this.readPersistedUris());
  }

  private async restorePinnedTabs(): Promise<void> {
    const targets = this.readPersistedUris();
    if (targets.length === 0) {
      return;
    }

    if (this.getRestoreBehavior() === 'reopenAndPin') {
      const reopenLimit = this.getRestoreReopenLimit();
      const reopenTargets = targets.slice(0, reopenLimit);
      const remainder = targets.length - reopenTargets.length;
      if (reopenTargets.length > 0) {
        await this.pinUris(reopenTargets, {
          showProgress: false,
          title: t('Restoring pinned files'),
          openIfClosed: true
        });
      }
      if (remainder > 0) {
        logger.debug(`Restore limited to ${reopenLimit} files, kept ${remainder} in tree only.`);
        void vscode.window.showInformationMessage(
          t(
            'Restore complete. Files reopened: {0}; remaining in the sidebar only: {1}.',
            reopenTargets.length,
            remainder
          )
        );
      }
    }

    await this.pruneMissingFiles();
  }

  /** Drops records of files that were deleted while the extension was not running. */
  private async pruneMissingFiles(): Promise<void> {
    const openKeys = new Set(
      this.getOpenTabs()
        .map((tab) => getPrimaryTabUri(tab))
        .filter((uri): uri is vscode.Uri => Boolean(uri))
        .map((uri) => toUriKey(uri))
    );
    const candidates = [...this.pinnedByKey.values()].filter(
      (record) => record.uri.scheme === 'file' && !openKeys.has(record.key)
    );

    const missing: vscode.Uri[] = [];
    for (const chunk of this.chunk(candidates, 20)) {
      await Promise.all(
        chunk.map(async (record) => {
          try {
            await vscode.workspace.fs.stat(record.uri);
          } catch (error) {
            if (isFileNotFound(error)) {
              missing.push(record.uri);
            }
          }
        })
      );
    }

    if (missing.length > 0 && !this.disposed) {
      logger.debug(`Removing ${missing.length} pinned-file records for files that no longer exist`);
      this.removePinnedRecords(missing);
    }
  }

  // ---------------------------------------------------------------------------
  // Applying pin / unpin
  // ---------------------------------------------------------------------------

  private async applyPinState(
    uris: vscode.Uri[],
    shouldPin: boolean,
    options?: PinOptions
  ): Promise<BatchOutcome> {
    const unique = [
      ...new Map(
        uris.filter((uri) => isTrackableUri(uri)).map((uri) => [toUriKey(uri), uri])
      ).values()
    ];
    if (unique.length === 0) {
      return emptyOutcome();
    }

    return this.batchQueue.runExclusive(async () => {
      if (shouldPin) {
        this.addPinnedRecords(unique);
      }

      const showProgress = options?.showProgress ?? unique.length >= 20;
      if (!showProgress) {
        return this.executeBatch(unique, shouldPin, options);
      }

      return vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: options?.title ?? (shouldPin ? t('Pinning files') : t('Unpinning files'))
        },
        async (progress) => {
          progress.report({ message: t('Processing items ({0})...', unique.length) });
          const result = await this.executeBatch(unique, shouldPin, options, progress);
          progress.report({ message: t('Finalizing...') });
          return result;
        }
      );
    });
  }

  private async executeBatch(
    unique: vscode.Uri[],
    shouldPin: boolean,
    options: PinOptions | undefined,
    progress?: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<BatchOutcome> {
    const outcome = emptyOutcome();
    const recordsToDrop: vscode.Uri[] = [];
    const original = this.captureActiveTab();
    const tracker = { touched: false };
    let processed = 0;

    // Processing order affects visible flicker: files that need no tab switch go first,
    // then the active tab, and only afterwards the ones that must be focused. This keeps
    // the number of tab switches (and the time a foreign tab is active) to a minimum.
    const ordered = this.orderForMinimalFocusChanges(unique, shouldPin);

    this.applyingState = true;
    try {
      for (const batch of this.chunk(ordered, this.getBatchSize())) {
        const results = await Promise.allSettled(
          batch.map((uri) =>
            this.applyPinStateForUri(uri, shouldPin, options?.openIfClosed, tracker)
          )
        );

        results.forEach((result, index) => {
          const uri = batch[index];
          processed += 1;

          const value: UriResult =
            result.status === 'rejected'
              ? { status: 'failed', error: this.formatError(uri, result.reason) }
              : result.value;

          if (value.status === 'success') {
            outcome.success += 1;
          } else if (value.status === 'failed') {
            outcome.failed += 1;
            if (value.error) {
              outcome.errors.push(value.error);
            }
          } else {
            outcome.skipped += 1;
          }

          if (value.missing || (!shouldPin && value.status !== 'failed')) {
            recordsToDrop.push(uri);
          }

          progress?.report({
            increment: 100 / unique.length,
            message: t(
              '{0}/{1} ({2}%)',
              processed,
              unique.length,
              Math.round((processed / unique.length) * 100)
            )
          });
        });
      }
    } finally {
      // Must always be reset, otherwise tab tracking would stay frozen after one failure.
      this.applyingState = false;
    }

    if (recordsToDrop.length > 0) {
      this.removePinnedRecords(recordsToDrop);
    }
    await this.restoreActiveTab(original, tracker.touched);
    this.refreshFromTabs(true);

    if (this.refreshRequestedWhileApplying) {
      this.refreshRequestedWhileApplying = false;
      this.scheduleRefresh();
    }
    return outcome;
  }

  /**
   * Reorders targets so the batch switches tabs as little as possible:
   * 1) tabs that already have the wanted state (no-op / skipped),
   * 2) the currently active tab,
   * 3) everything else (each requires focusing its tab).
   */
  private orderForMinimalFocusChanges(uris: vscode.Uri[], shouldPin: boolean): vscode.Uri[] {
    const activeUri = this.getActiveUri();
    const activeKey = activeUri ? toUriKey(activeUri) : undefined;

    const rank = (uri: vscode.Uri): number => {
      const key = toUriKey(uri);
      const tabs = this.findTabs(uri);
      const needsSwitch = tabs.length === 0 || tabs.every((tab) => tab.isPinned !== shouldPin);
      if (!needsSwitch) {
        return 0;
      }
      return key === activeKey ? 1 : 2;
    };

    // Stable sort: preserve the caller's order within the same rank.
    return [...uris]
      .map((uri, index) => ({ uri, index, rank: rank(uri) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.uri);
  }

  private async applyPinStateForUri(
    uri: vscode.Uri,
    shouldPin: boolean,
    openIfClosed: boolean | undefined,
    tracker: { touched: boolean }
  ): Promise<UriResult> {
    const tabs = this.findTabs(uri);

    if (tabs.length === 0) {
      const shouldOpen = openIfClosed ?? this.getRestoreBehavior() === 'reopenAndPin';
      if (!shouldPin || !shouldOpen) {
        return { status: 'skipped' };
      }
      return this.openAndToggleUri(uri, true, undefined, tracker);
    }

    const target = tabs.find((tab) => tab.isPinned !== shouldPin);
    if (!target) {
      return { status: 'skipped' };
    }
    return this.openAndToggleUri(uri, shouldPin, target, tracker);
  }

  private async checkReopenable(uri: vscode.Uri): Promise<UriResult | undefined> {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) {
        return { status: 'skipped', missing: true };
      }
    } catch (error) {
      if (isFileNotFound(error)) {
        return { status: 'skipped', missing: true };
      }
    }
    return undefined;
  }

  private async openAndToggleUri(
    uri: vscode.Uri,
    shouldPin: boolean,
    tab: vscode.Tab | undefined,
    tracker: { touched: boolean }
  ): Promise<UriResult> {
    const command = shouldPin ? 'workbench.action.pinEditor' : 'workbench.action.unpinEditor';
    try {
      if (!tab) {
        const blocked = await this.checkReopenable(uri);
        if (blocked) {
          return blocked;
        }
      }

      await this.focusQueue.runExclusive(async () => {
        // The pin command always acts on the *active* editor, so it must be the right one.
        if (!this.isActiveWithState(uri, shouldPin)) {
          await vscode.commands.executeCommand('vscode.open', uri, {
            viewColumn: tab?.group.viewColumn,
            preview: false,
            preserveFocus: false
          });
          tracker.touched = true;

          const active = await this.waitFor(
            () => this.isActiveWithState(uri, shouldPin),
            ACTIVATION_TIMEOUT_MS
          );
          if (!active) {
            throw new Error('the editor did not become active');
          }
        }

        await vscode.commands.executeCommand(command);
        await this.waitFor(
          () => this.findTabs(uri).some((candidate) => candidate.isPinned === shouldPin),
          STATE_SETTLE_TIMEOUT_MS
        );
      });
      return { status: 'success' };
    } catch (error) {
      logger.debug(`Failed ${shouldPin ? 'pin' : 'unpin'} for ${uri.fsPath}: ${String(error)}`);
      return { status: 'failed', error: this.formatError(uri, error) };
    }
  }

  // ---------------------------------------------------------------------------
  // In-memory records
  // ---------------------------------------------------------------------------

  private replacePinnedRecords(uris: vscode.Uri[]): void {
    const next = new Map<string, PinRecord>();
    for (const uri of uris) {
      const record = toPinRecord(uri);
      next.set(record.key, record);
    }
    if (!this.didPinnedSetChange(next)) {
      return;
    }
    this.pinnedByKey = next;
    this.cacheDirty = true;
    this.schedulePersist();
    this.onDidChangeEmitter.fire();
  }

  private addPinnedRecords(uris: vscode.Uri[]): void {
    let changed = false;
    for (const uri of uris) {
      const record = toPinRecord(uri);
      if (!this.pinnedByKey.has(record.key)) {
        this.pinnedByKey.set(record.key, record);
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
    this.cacheDirty = true;
    this.schedulePersist();
    this.onDidChangeEmitter.fire();
  }

  private removePinnedRecords(uris: vscode.Uri[]): void {
    let changed = false;
    for (const uri of uris) {
      changed = this.pinnedByKey.delete(toUriKey(uri)) || changed;
    }
    if (!changed) {
      return;
    }
    this.cacheDirty = true;
    this.schedulePersist();
    this.onDidChangeEmitter.fire();
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  private getPersistenceMemento(): vscode.Memento {
    return this.getMemento(this.getPersistenceScope());
  }

  private getPersistenceScope(): PersistenceScope {
    return vscode.workspace
      .getConfiguration('pin-context')
      .get<PersistenceScope>('persistenceScope', 'workspaceState');
  }

  private getMemento(scope: PersistenceScope): vscode.Memento {
    return scope === 'workspaceState' ? this.context.workspaceState : this.context.globalState;
  }

  private getRestoreBehavior(): RestoreBehavior {
    return vscode.workspace
      .getConfiguration('pin-context')
      .get<RestoreBehavior>('restoreBehavior', 'keepInTree');
  }

  private getBatchSize(): number {
    const configured = vscode.workspace
      .getConfiguration('pin-context')
      .get<number>('batchSize', DEFAULT_BATCH_SIZE);
    return Math.max(1, Math.min(20, Number(configured) || DEFAULT_BATCH_SIZE));
  }

  private getFindFilesLimit(): number {
    const configured = vscode.workspace
      .getConfiguration('pin-context')
      .get<number>('findFilesMaxResults', DEFAULT_FIND_FILES_LIMIT);
    return Math.max(100, Math.min(10000, Number(configured) || DEFAULT_FIND_FILES_LIMIT));
  }

  private getRestoreReopenLimit(): number {
    const configured = vscode.workspace
      .getConfiguration('pin-context')
      .get<number>('restoreReopenLimit', DEFAULT_RESTORE_REOPEN_LIMIT);
    const value = Number.isFinite(Number(configured))
      ? Number(configured)
      : DEFAULT_RESTORE_REOPEN_LIMIT;
    return Math.max(0, Math.min(500, value));
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks;
  }

  private formatError(uri: vscode.Uri, error: unknown): string {
    return `${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
