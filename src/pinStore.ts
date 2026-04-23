import * as vscode from 'vscode';
import { minimatch } from 'minimatch';
import { PinRecord, getPrimaryTabUri, toPinRecord, toUriKey } from './tabUtils';

const PERSISTED_PINS_KEY = 'pin-context.pinnedUris';
const TAB_REFRESH_DEBOUNCE_MS = 100;
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_FIND_FILES_LIMIT = 2000;
const DEFAULT_RESTORE_REOPEN_LIMIT = 50;

type PersistenceScope = 'globalState' | 'workspaceState';
type RestoreBehavior = 'keepInTree' | 'reopenAndPin';

export interface BatchOutcome {
  success: number;
  failed: number;
  skipped: number;
  errors: string[];
}

export class PinStore implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private readonly tabChangeDisposable: vscode.Disposable;
  private refreshTimer: NodeJS.Timeout | undefined;
  private batchQueue: Promise<void> = Promise.resolve();
  private focusCommandQueue: Promise<void> = Promise.resolve();
  private applyingState = false;
  private refreshRequestedWhileApplying = false;

  private pinnedByKey = new Map<string, PinRecord>();
  private cachedList: PinRecord[] = [];
  private cacheDirty = true;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.tabChangeDisposable = vscode.window.tabGroups.onDidChangeTabs(() => {
      this.scheduleRefresh();
    });

    this.initializeFromPersistedState();
    this.refreshFromTabs(true);
    void this.restorePinnedTabs();
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.tabChangeDisposable.dispose();
    this.onDidChangeEmitter.dispose();
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

  async pinCurrentEditor(): Promise<BatchOutcome> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      vscode.window.showWarningMessage('No active editor to pin');
      return { success: 0, failed: 0, skipped: 0, errors: [] };
    }
    return this.pinUris([uri]);
  }

  async unpinCurrentEditor(): Promise<BatchOutcome> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      vscode.window.showWarningMessage('No active editor to unpin');
      return { success: 0, failed: 0, skipped: 0, errors: [] };
    }
    return this.unpinUris([uri]);
  }

  async togglePinCurrentEditor(): Promise<BatchOutcome> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      vscode.window.showWarningMessage('No active editor');
      return { success: 0, failed: 0, skipped: 0, errors: [] };
    }
    return this.isUriPinned(uri) ? this.unpinUris([uri]) : this.pinUris([uri]);
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

  async pinEditorsByPattern(pattern: string): Promise<BatchOutcome> {
    const matchingFiles = await vscode.workspace.findFiles(
      pattern,
      undefined,
      this.getFindFilesLimit()
    );
    const matchingKeys = new Set(matchingFiles.map((uri) => toUriKey(uri)));

    const targets = this.getOpenTabs()
      .filter((tab) => {
        const uri = getPrimaryTabUri(tab);
        if (!uri || tab.isPinned) {
          return false;
        }
        return (
          matchingKeys.has(toUriKey(uri)) ||
          minimatch(uri.path, pattern, { nocase: true, dot: true })
        );
      })
      .map((tab) => getPrimaryTabUri(tab))
      .filter((uri): uri is vscode.Uri => Boolean(uri));

    return this.pinUris(targets);
  }

  async unpinUri(uri: vscode.Uri): Promise<BatchOutcome> {
    return this.unpinUris([uri]);
  }

  async pinUris(
    uris: vscode.Uri[],
    options?: { showProgress?: boolean; title?: string }
  ): Promise<BatchOutcome> {
    return this.applyPinState(uris, true, options);
  }

  async unpinUris(
    uris: vscode.Uri[],
    options?: { showProgress?: boolean; title?: string }
  ): Promise<BatchOutcome> {
    return this.applyPinState(uris, false, options);
  }

  private isUriPinned(uri: vscode.Uri): boolean {
    return this.pinnedByKey.has(toUriKey(uri));
  }

  private getOpenTabs(): vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
  }

  private scheduleRefresh(): void {
    if (this.applyingState) {
      this.refreshRequestedWhileApplying = true;
      return;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refreshFromTabs();
    }, TAB_REFRESH_DEBOUNCE_MS);
  }

  private refreshFromTabs(forceEmit = false): void {
    const next = new Map(this.pinnedByKey);
    for (const tab of this.getOpenTabs()) {
      const uri = getPrimaryTabUri(tab);
      if (!uri) {
        continue;
      }
      const key = toUriKey(uri);
      if (tab.isPinned) {
        next.set(key, toPinRecord(uri));
      } else {
        next.delete(key);
      }
    }

    const changed = this.didPinnedSetChange(next);
    if (!changed && !forceEmit) {
      return;
    }

    this.pinnedByKey = next;
    this.cacheDirty = true;
    void this.persistPinnedUris();
    this.onDidChangeEmitter.fire();
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

  private async persistPinnedUris(): Promise<void> {
    const uris = [...this.pinnedByKey.values()].map((item) => item.uri.toString());
    await this.getPersistenceMemento().update(PERSISTED_PINS_KEY, uris);
  }

  private async restorePinnedTabs(): Promise<void> {
    const rawUris = this.getPersistenceMemento().get<string[]>(PERSISTED_PINS_KEY, []);
    if (rawUris.length === 0) {
      return;
    }

    const targets = rawUris
      .map((value) => {
        try {
          return vscode.Uri.parse(value);
        } catch {
          return undefined;
        }
      })
      .filter((uri): uri is vscode.Uri => Boolean(uri));

    this.replacePinnedRecords(targets);

    if (this.getRestoreBehavior() === 'reopenAndPin') {
      const reopenLimit = this.getRestoreReopenLimit();
      const reopenTargets = targets.slice(0, reopenLimit);
      const remainder = targets.length - reopenTargets.length;
      if (reopenTargets.length > 0) {
        await this.pinUris(reopenTargets, { showProgress: false, title: 'Restoring pinned files' });
      }
      if (remainder > 0) {
        this.debugLog(`Restore limited to ${reopenLimit} files, kept ${remainder} in tree only.`);
        void vscode.window.showInformationMessage(
          `Restored ${reopenTargets.length} pinned tab(s). ${remainder} remain in sidebar and will be pinned when opened.`
        );
      }
    } else {
      this.refreshFromTabs(true);
    }
  }

  private async applyPinState(
    uris: vscode.Uri[],
    shouldPin: boolean,
    options?: {
      showProgress?: boolean;
      title?: string;
    }
  ): Promise<BatchOutcome> {
    const unique = [...new Map(uris.map((uri) => [toUriKey(uri), uri])).values()];
    if (unique.length === 0) {
      return { success: 0, failed: 0, skipped: 0, errors: [] };
    }

    return this.enqueueBatch(async () => {
      if (shouldPin) {
        this.addPinnedRecords(unique);
      }
      const execution = async (
        reportProgress?: vscode.Progress<{ message?: string; increment?: number }>
      ) => {
        this.applyingState = true;
        let success = 0;
        let failed = 0;
        let skipped = 0;
        const errors: string[] = [];
        let processed = 0;

        const batches = this.chunkUris(unique, this.getBatchSize());
        for (const batch of batches) {
          const results = await Promise.allSettled(
            batch.map((uri) => this.applyPinStateForUri(uri, shouldPin))
          );
          for (const result of results) {
            if (result.status === 'rejected') {
              failed += 1;
              errors.push(String(result.reason));
              continue;
            }

            if (result.value.status === 'success') {
              success += 1;
            } else if (result.value.status === 'failed') {
              failed += 1;
              if (result.value.error) {
                errors.push(result.value.error);
              }
            } else {
              skipped += 1;
            }
            processed += 1;
            if (reportProgress) {
              const percent = Math.round((processed / unique.length) * 100);
              reportProgress.report({
                increment: 100 / unique.length,
                message: `${processed}/${unique.length} (${percent}%)`
              });
            }
          }
        }

        if (!shouldPin) {
          this.removePinnedRecords(unique);
        }
        this.applyingState = false;
        this.refreshFromTabs(true);
        if (this.refreshRequestedWhileApplying) {
          this.refreshRequestedWhileApplying = false;
          this.scheduleRefresh();
        }
        return { success, failed, skipped, errors };
      };

      const showProgress = options?.showProgress ?? unique.length >= 20;
      if (!showProgress) {
        return execution();
      }

      return vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: options?.title ?? (shouldPin ? 'Pinning files' : 'Unpinning files')
        },
        async (progress) => {
          progress.report({ message: `Processing ${unique.length} item(s)...` });
          const result = await execution(progress);
          progress.report({ message: 'Finalizing...' });
          return result;
        }
      );
    });
  }

  private async applyPinStateForUri(
    uri: vscode.Uri,
    shouldPin: boolean
  ): Promise<{ status: 'success' | 'failed' | 'skipped'; error?: string }> {
    const tab = this.findTabByUri(uri);
    if (!tab) {
      if (shouldPin && this.getRestoreBehavior() === 'reopenAndPin') {
        return this.openAndToggleUri(uri, shouldPin);
      }
      return { status: 'skipped' };
    }
    if (tab.isPinned === shouldPin) {
      return { status: 'skipped' };
    }
    return this.openAndToggleUri(uri, shouldPin);
  }

  private async openAndToggleUri(
    uri: vscode.Uri,
    shouldPin: boolean
  ): Promise<{ status: 'success' | 'failed'; error?: string }> {
    const command = shouldPin ? 'workbench.action.pinEditor' : 'workbench.action.unpinEditor';
    try {
      await this.runFocusCommand(async () => {
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        if (!activeUri || toUriKey(activeUri) !== toUriKey(uri)) {
          await vscode.window.showTextDocument(uri, { preview: false, preserveFocus: true });
        }
        await vscode.commands.executeCommand(command);
      });
      return { status: 'success' };
    } catch (error) {
      this.debugLog(`Failed ${shouldPin ? 'pin' : 'unpin'} for ${uri.fsPath}: ${String(error)}`);
      return { status: 'failed', error: this.formatError(uri, error) };
    }
  }

  private findTabByUri(uri: vscode.Uri): vscode.Tab | undefined {
    const key = toUriKey(uri);
    return this.getOpenTabs().find((tab) => {
      const tabUri = getPrimaryTabUri(tab);
      return tabUri ? toUriKey(tabUri) === key : false;
    });
  }

  private runFocusCommand<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.focusCommandQueue;
    let release!: () => void;
    this.focusCommandQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    return previous.then(operation).finally(() => {
      release();
    });
  }

  private async enqueueBatch<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.batchQueue;
    let release!: () => void;
    this.batchQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private initializeFromPersistedState(): void {
    const rawUris = this.getPersistenceMemento().get<string[]>(PERSISTED_PINS_KEY, []);
    const uris = rawUris
      .map((value) => {
        try {
          return vscode.Uri.parse(value);
        } catch {
          return undefined;
        }
      })
      .filter((uri): uri is vscode.Uri => Boolean(uri));
    this.replacePinnedRecords(uris);
  }

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
    void this.persistPinnedUris();
    this.onDidChangeEmitter.fire();
  }

  private addPinnedRecords(uris: vscode.Uri[]): void {
    let changed = false;
    for (const uri of uris) {
      const record = toPinRecord(uri);
      if (!this.pinnedByKey.has(record.key)) {
        changed = true;
      }
      this.pinnedByKey.set(record.key, record);
    }
    if (!changed) {
      return;
    }
    this.cacheDirty = true;
    void this.persistPinnedUris();
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
    void this.persistPinnedUris();
    this.onDidChangeEmitter.fire();
  }

  private getPersistenceScope(): PersistenceScope {
    const config = vscode.workspace.getConfiguration('pin-context');
    return config.get<PersistenceScope>('persistenceScope', 'globalState');
  }

  private getRestoreBehavior(): RestoreBehavior {
    const config = vscode.workspace.getConfiguration('pin-context');
    return config.get<RestoreBehavior>('restoreBehavior', 'keepInTree');
  }

  private getPersistenceMemento(): vscode.Memento {
    return this.getPersistenceScope() === 'workspaceState'
      ? this.context.workspaceState
      : this.context.globalState;
  }

  private getBatchSize(): number {
    const config = vscode.workspace.getConfiguration('pin-context');
    const configured = config.get<number>('batchSize', DEFAULT_BATCH_SIZE);
    return Math.max(1, Math.min(20, configured));
  }

  private getFindFilesLimit(): number {
    const config = vscode.workspace.getConfiguration('pin-context');
    const configured = config.get<number>('findFilesMaxResults', DEFAULT_FIND_FILES_LIMIT);
    return Math.max(100, Math.min(10000, configured));
  }

  private getRestoreReopenLimit(): number {
    const config = vscode.workspace.getConfiguration('pin-context');
    const configured = config.get<number>('restoreReopenLimit', DEFAULT_RESTORE_REOPEN_LIMIT);
    return Math.max(0, Math.min(500, configured));
  }

  private isDebugEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('pin-context');
    return config.get<boolean>('debug', false);
  }

  private chunkUris(uris: vscode.Uri[], chunkSize: number): vscode.Uri[][] {
    const chunks: vscode.Uri[][] = [];
    for (let index = 0; index < uris.length; index += chunkSize) {
      chunks.push(uris.slice(index, index + chunkSize));
    }
    return chunks;
  }

  private formatError(uri: vscode.Uri, error: unknown): string {
    return `${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`;
  }

  private debugLog(message: string): void {
    if (!this.isDebugEnabled()) {
      return;
    }
    console.log(`[pin-context] ${message}`);
  }
}
