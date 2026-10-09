import * as vscode from 'vscode';
import {
  ContextEditorState,
  ContextOpenTab,
  ContextSnapshot,
  ContextTimelineEntry,
  PinContext,
  TimelineAction
} from '../types';
import { logger } from '../utils/logger';
import { t } from '../l10n';

const CONTEXTS_STATE_KEY = 'pin-context.contexts.snapshot';
const LAST_PERSISTENCE_SCOPE_KEY = 'pin-context.contexts.persistenceScope.last';

type PersistenceScope = 'globalState' | 'workspaceState';

const TIMELINE_ACTIONS = new Set<TimelineAction>(['switch', 'save', 'create', 'restore']);
const CONTEXT_SOURCES = new Set(['manual', 'git', 'repo']);

function sanitizeEditorStates(raw: unknown): ContextEditorState[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const states = raw.flatMap((item): ContextEditorState[] => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const value = item as Partial<ContextEditorState>;
    if (typeof value.uri !== 'string' || !Number.isFinite(value.line)) {
      return [];
    }
    const state: ContextEditorState = {
      uri: value.uri,
      line: Math.max(0, Math.floor(value.line as number)),
      character: Math.max(0, Math.floor(Number(value.character) || 0))
    };
    if (Number.isFinite(value.scrollLine)) {
      state.scrollLine = Math.max(0, Math.floor(value.scrollLine as number));
    }
    return [state];
  });
  return states.length > 0 ? states : undefined;
}

function sanitizeOpenTabs(raw: unknown): ContextOpenTab[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const tabs = raw.flatMap((item): ContextOpenTab[] => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const value = item as Partial<ContextOpenTab>;
    if (typeof value.uri !== 'string') {
      return [];
    }
    const tab: ContextOpenTab = {
      uri: value.uri,
      group: Math.max(0, Math.floor(Number(value.group) || 0))
    };
    if (value.active === true) {
      tab.active = true;
    }
    return [tab];
  });
  return tabs.length > 0 ? tabs : undefined;
}

function sanitizeContext(raw: unknown): PinContext | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const value = raw as Partial<PinContext>;
  if (typeof value.id !== 'string' || typeof value.name !== 'string' || !value.id) {
    return undefined;
  }
  const now = Date.now();
  return {
    id: value.id,
    name: value.name,
    source: CONTEXT_SOURCES.has(value.source ?? '') ? value.source! : 'manual',
    workspaceFolder: typeof value.workspaceFolder === 'string' ? value.workspaceFolder : undefined,
    branch: typeof value.branch === 'string' ? value.branch : undefined,
    changed: typeof value.changed === 'number' ? value.changed : undefined,
    staged: typeof value.staged === 'number' ? value.staged : undefined,
    pinnedUris: Array.isArray(value.pinnedUris)
      ? value.pinnedUris.filter((uri): uri is string => typeof uri === 'string')
      : [],
    editorStates: sanitizeEditorStates(value.editorStates),
    openTabs: sanitizeOpenTabs(value.openTabs),
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : now
  };
}

function sanitizeTimelineEntry(raw: unknown): ContextTimelineEntry | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const value = raw as Partial<ContextTimelineEntry>;
  if (
    typeof value.id !== 'string' ||
    typeof value.contextId !== 'string' ||
    typeof value.contextName !== 'string' ||
    typeof value.timestamp !== 'number' ||
    !value.action ||
    !TIMELINE_ACTIONS.has(value.action)
  ) {
    return undefined;
  }
  return {
    id: value.id,
    contextId: value.contextId,
    contextName: value.contextName,
    timestamp: value.timestamp,
    action: value.action
  };
}

/** Guards against corrupted or older-format data that used to crash activation. */
export function sanitizeSnapshot(raw: unknown): ContextSnapshot | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const value = raw as Partial<ContextSnapshot>;
  const contexts = (Array.isArray(value.contexts) ? value.contexts : [])
    .map(sanitizeContext)
    .filter((item): item is PinContext => Boolean(item));
  const timeline = (Array.isArray(value.timeline) ? value.timeline : [])
    .map(sanitizeTimelineEntry)
    .filter((item): item is ContextTimelineEntry => Boolean(item));

  return {
    contexts,
    timeline,
    activeContextId: typeof value.activeContextId === 'string' ? value.activeContextId : undefined,
    lastActiveContextId:
      typeof value.lastActiveContextId === 'string' ? value.lastActiveContextId : undefined
  };
}

export class ContextPersistenceService {
  private saveErrorShown = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Loads the configured persistence scope and migrates the snapshot when the user changes
   * scopes. The previous scope is cleared only after the new copy has been saved, so stale
   * data cannot reappear when the setting is switched back later.
   */
  async load(): Promise<ContextSnapshot | undefined> {
    const preferred = this.getScope();
    const fallback: PersistenceScope =
      preferred === 'globalState' ? 'workspaceState' : 'globalState';

    const lastScope = this.context.workspaceState.get<PersistenceScope | undefined>(
      LAST_PERSISTENCE_SCOPE_KEY
    );

    // When a previously configured scope changes, the source marked during the last load/save
    // is authoritative. Do not prefer a potentially stale snapshot already in the destination.
    if (
      (lastScope === 'globalState' || lastScope === 'workspaceState') &&
      lastScope !== preferred
    ) {
      const previous = this.readSnapshot(lastScope);
      if (previous) {
        await this.moveSnapshot(previous, lastScope, preferred);
        return previous;
      }
    }

    const preferredSnapshot = this.readSnapshot(preferred);
    if (preferredSnapshot) {
      await this.rememberScope(preferred);
      return preferredSnapshot;
    }

    // Older versions did not track the selected scope. If the preferred scope is empty,
    // migrate the legacy snapshot from the other scope instead of making the data disappear.
    const fallbackSnapshot = this.readSnapshot(fallback);
    if (fallbackSnapshot) {
      await this.moveSnapshot(fallbackSnapshot, fallback, preferred);
      return fallbackSnapshot;
    }

    await this.rememberScope(preferred);
    return undefined;
  }

  private readSnapshot(scope: PersistenceScope): ContextSnapshot | undefined {
    try {
      return sanitizeSnapshot(this.getMemento(scope).get<unknown>(CONTEXTS_STATE_KEY));
    } catch (error) {
      logger.error(`Failed to load contexts snapshot from ${scope}`, error);
      return undefined;
    }
  }

  private async moveSnapshot(
    snapshot: ContextSnapshot,
    from: PersistenceScope,
    to: PersistenceScope
  ): Promise<boolean> {
    try {
      await this.getMemento(to).update(CONTEXTS_STATE_KEY, snapshot);
      // Record the destination before any source cleanup. The marker makes this workspace's
      // choice authoritative even when a shared global snapshot must be retained for others.
      if (!(await this.rememberScope(to))) {
        this.showSaveErrorOnce();
        return false;
      }
      // globalState is shared by every workspace. Keep it when copying into one workspace,
      // otherwise a workspace-level override would erase contexts used by other workspaces.
      if (from !== 'globalState' || to !== 'workspaceState') {
        try {
          await this.getMemento(from).update(CONTEXTS_STATE_KEY, undefined);
        } catch (error) {
          logger.warn(`Migrated contexts to ${to}, but could not clear the old ${from} snapshot`);
          logger.debug(String(error));
        }
      }
      return true;
    } catch (error) {
      logger.error(`Failed to migrate contexts from ${from} to ${to}`, error);
      this.showSaveErrorOnce();
      return false;
    }
  }

  private async rememberScope(scope: PersistenceScope): Promise<boolean> {
    try {
      await this.context.workspaceState.update(LAST_PERSISTENCE_SCOPE_KEY, scope);
      return true;
    } catch (error) {
      logger.error('Failed to remember contexts persistence scope', error);
      return false;
    }
  }

  async save(snapshot: ContextSnapshot): Promise<boolean> {
    const scope = this.getScope();
    const previousScope = this.context.workspaceState.get<PersistenceScope | undefined>(
      LAST_PERSISTENCE_SCOPE_KEY
    );
    const target = this.getMemento(scope);
    let previousTargetValue: unknown;
    try {
      previousTargetValue = target.get<unknown>(CONTEXTS_STATE_KEY);
      await target.update(CONTEXTS_STATE_KEY, snapshot);
      if (
        (previousScope === 'globalState' || previousScope === 'workspaceState') &&
        previousScope !== scope
      ) {
        // Saving the current in-memory snapshot into the newly selected scope is the migration
        // point for live setting changes. Only clear the old copy after the new write succeeds.
        if (!(await this.rememberScope(scope))) {
          await target.update(CONTEXTS_STATE_KEY, previousTargetValue);
          this.showSaveErrorOnce();
          return false;
        }
        // globalState is shared across workspaces; do not delete it when this one workspace
        // changes to workspaceState. Its local scope marker makes the workspace copy authoritative
        // here, while other workspaces can continue reading the shared snapshot.
        if (previousScope !== 'globalState' || scope !== 'workspaceState') {
          try {
            await this.getMemento(previousScope).update(CONTEXTS_STATE_KEY, undefined);
          } catch (error) {
            // The destination and scope marker are already authoritative. Stale-copy cleanup is
            // best-effort and must not turn a successfully saved snapshot into a reported failure.
            logger.warn(
              `Saved contexts to ${scope}, but could not clear the old ${previousScope} snapshot`
            );
            logger.debug(String(error));
          }
        }
      } else {
        if (!(await this.rememberScope(scope))) {
          // The snapshot was saved to the same scope; losing the marker is recoverable because
          // the next activation will prefer this snapshot and attempt to record the scope again.
          logger.warn('Saved contexts but could not remember the active persistence scope');
        }
      }
      return true;
    } catch (error) {
      logger.error('Failed to persist contexts snapshot', error);
      this.showSaveErrorOnce();
      return false;
    }
  }

  private showSaveErrorOnce(): void {
    if (this.saveErrorShown) {
      return;
    }
    this.saveErrorShown = true;
    void vscode.window.showErrorMessage(t('Pin Context: failed to save context data'));
  }

  private getScope(): PersistenceScope {
    const configured = vscode.workspace
      .getConfiguration('pin-context')
      .get<PersistenceScope>('contexts.persistenceScope', 'workspaceState');
    return configured === 'globalState' ? 'globalState' : 'workspaceState';
  }

  private getMemento(scope: PersistenceScope): vscode.Memento {
    return scope === 'workspaceState' ? this.context.workspaceState : this.context.globalState;
  }
}
