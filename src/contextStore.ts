import * as vscode from 'vscode';
import { ContextSnapshot, ContextTimelineEntry, PinContext } from './types';
import { GitContextService } from './gitContextService';
import { PinStore } from './pinStore';
import { toUriKey } from './tabUtils';

const CONTEXTS_STATE_KEY = 'pin-context.contexts.snapshot';

export class ContextStore implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private readonly pinStoreDisposable: vscode.Disposable;
  private gitBranchDisposable: vscode.Disposable;
  private gitStatusDisposable: vscode.Disposable;

  private isApplyingContext = false;

  private readonly contexts = new Map<string, PinContext>();
  private activeContextId: string | undefined;
  private lastActiveContextId: string | undefined;
  private timeline: ContextTimelineEntry[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly pinStore: PinStore,
    private readonly gitContextService: GitContextService
  ) {
    this.pinStoreDisposable = this.pinStore.onDidChange(() => {
      if (this.isApplyingContext) return;
      void this.syncActiveContextFromPins();
    });

    this.gitBranchDisposable = this.gitContextService.onDidChangeBranch(async (event) => {
      const gitContextId = `git:${event.workspaceFolder}:${event.newBranch}`;

      const exists = this.contexts.has(gitContextId);
      if (!exists) {
        await this.refreshGitContexts();
      } else {
        await this.refreshGitContexts();
      }

      const autoSwitch = this.getConfig<boolean>('contexts.autoSwitchOnGitBranchChange', true);

      if (autoSwitch) {
        const target = this.contexts.get(gitContextId);
        if (target) {
          await this.switchContext(gitContextId, 'switch');
        }
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

    if (this.getConfig<boolean>('contexts.restoreLastContext', true)) {
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
    const pinnedUris = this.pinStore.getPinnedUris().map((uri) => uri.toString());

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

    item.pinnedUris = this.pinStore.getPinnedUris().map((uri) => uri.toString());
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

    this.isApplyingContext = true;

    try {
      const targetUris = target.pinnedUris.map((u) => vscode.Uri.parse(u));

      const current = this.pinStore.getPinnedUris();
      const currentKeys = new Set(current.map((u) => toUriKey(u)));
      const targetKeys = new Set(targetUris.map((u) => toUriKey(u)));

      const toUnpin = current.filter((u) => !targetKeys.has(toUriKey(u)));
      const toPin = targetUris.filter((u) => !currentKeys.has(toUriKey(u)));

      if (toUnpin.length > 0) {
        await this.pinStore.unpinUris(toUnpin, {
          showProgress: toUnpin.length > 15,
          title: `Switching to ${target.name}`
        });
      }

      if (toPin.length > 0) {
        await this.pinStore.pinUris(toPin, {
          showProgress: toPin.length > 15,
          title: `Switching to ${target.name}`
        });
      }
    } finally {
      this.isApplyingContext = false;
    }

    this.lastActiveContextId = this.activeContextId;
    this.activeContextId = contextId;

    target.updatedAt = Date.now();
    this.contexts.set(contextId, target);

    this.pushTimeline(contextId, target.name, action);

    await this.persist();
    this.onDidChangeEmitter.fire();

    return true;
  }

  async refreshGitContexts(): Promise<void> {
    if (!this.getConfig<boolean>('contexts.autoGitContexts', false)) return;

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
    if (!this.getConfig<boolean>('contexts.timelineEnabled', true)) return;

    this.timeline.unshift({
      id: `${contextId}:${Date.now()}:${action}`,
      contextId,
      contextName,
      action,
      timestamp: Date.now()
    });

    const max = this.getConfig<number>('contexts.maxTimelineEntries', 100);
    this.timeline = this.timeline.slice(0, max);
  }

  private load(): void {
    const snapshot = this.getStorage().get<ContextSnapshot | undefined>(CONTEXTS_STATE_KEY);
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

    await this.getStorage().update(CONTEXTS_STATE_KEY, snapshot);
  }

  private getStorage(): vscode.Memento {
    return this.context.workspaceState;
  }

  private getConfig<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration('pin-context').get<T>(key, fallback);
  }

  private async syncActiveContextFromPins(): Promise<void> {
    if (!this.activeContextId) return;

    const active = this.contexts.get(this.activeContextId);
    if (!active) return;

    const next = this.pinStore.getPinnedUris().map((u) => u.toString());
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
