import * as vscode from 'vscode';
import { ContextEditorState, ContextOpenTab, PinContext } from '../types';
import { getPrimaryTabUri, isTrackableUri, parseUri, toUriKey } from '../utils/tabUtils';
import { logger } from '../utils/logger';

export interface WorkingSet {
  editorStates?: ContextEditorState[];
  openTabs?: ContextOpenTab[];
}

const MAX_EDITOR_STATES = 60;
const MAX_OPEN_TABS = 80;

// The mock used by the tests (and older hosts) may not expose every editor API.
function getVisibleTextEditors(): readonly vscode.TextEditor[] {
  return vscode.window.visibleTextEditors ?? [];
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Captures and restores the "working set" of a context: where the caret was in each open
 * file, and which regular (non-pinned) tabs were open. Pinned files themselves are stored
 * in `PinContext.pinnedUris`; this only adds the parts that made the setup recognisable.
 */
export class WorkingSetService {
  capture(): WorkingSet {
    const set: WorkingSet = {};

    if (this.captureEditorState()) {
      const states = this.captureEditorStates();
      if (states.length > 0) {
        set.editorStates = states;
      }
    }

    if (this.captureOpenTabs()) {
      const tabs = this.captureOpenTabsList();
      if (tabs.length > 0) {
        set.openTabs = tabs;
      }
    }

    return set;
  }

  /**
   * Re-opens the tabs that belonged to the context and puts the caret back. Restoring is
   * best-effort: a missing file must not abort the context switch.
   *
   * Group layout: VS Code creates a missing group at the end of the row, so the tabs are
   * reopened by ascending group index and the active tab of the context goes last — its
   * group is then created at the position the layout had when the context was captured.
   */
  async restore(target: PinContext, token?: vscode.CancellationToken): Promise<void> {
    if (this.captureOpenTabs()) {
      await this.restoreOpenTabs(target.openTabs, token);
      await this.focusActiveTab(target.openTabs, token);
    }
    if (this.captureEditorState()) {
      this.restoreEditorStates(target.editorStates);
    }
  }

  /** Drops positions that no longer match any known file (after renames/imports). */
  prune(state: WorkingSet, keep: (uri: string) => boolean): WorkingSet {
    return {
      editorStates: state.editorStates?.filter((entry) => keep(entry.uri)),
      openTabs: state.openTabs?.filter((entry) => keep(entry.uri))
    };
  }

  // ---------------------------------------------------------------------------
  // Capture
  // ---------------------------------------------------------------------------

  private captureEditorStates(): ContextEditorState[] {
    const states: ContextEditorState[] = [];

    for (const editor of getVisibleTextEditors()) {
      const uri = editor.document?.uri;
      if (!uri || !isTrackableUri(uri)) {
        continue;
      }
      const cursor = editor.selection?.active;
      const state: ContextEditorState = {
        uri: uri.toString(),
        line: readNumber(cursor?.line) ?? 0,
        character: readNumber(cursor?.character) ?? 0
      };
      const scrollLine = readNumber(editor.visibleRanges?.[0]?.start?.line);
      if (scrollLine !== undefined) {
        state.scrollLine = scrollLine;
      }
      states.push(state);
      if (states.length >= MAX_EDITOR_STATES) {
        break;
      }
    }

    return states;
  }

  private captureOpenTabsList(): ContextOpenTab[] {
    const tabs: ContextOpenTab[] = [];

    vscode.window.tabGroups.all.forEach((group, index) => {
      const activeUri = group.activeTab ? getPrimaryTabUri(group.activeTab) : undefined;
      const activeKey = activeUri ? toUriKey(activeUri) : undefined;

      for (const tab of group.tabs) {
        // Pinned tabs are restored through the pin diff; storing them twice would
        // resurrect tabs the user deliberately unpinned.
        if (tab.isPinned) {
          continue;
        }
        const uri = getPrimaryTabUri(tab);
        if (!uri || !isTrackableUri(uri) || tabs.length >= MAX_OPEN_TABS) {
          continue;
        }
        tabs.push({
          uri: uri.toString(),
          group: index,
          active: activeKey !== undefined && activeKey === toUriKey(uri)
        });
      }
    });

    return tabs;
  }

  // ---------------------------------------------------------------------------
  // Restore
  // ---------------------------------------------------------------------------

  private async restoreOpenTabs(
    openTabs: ContextOpenTab[] | undefined,
    token?: vscode.CancellationToken
  ): Promise<void> {
    if (!openTabs || openTabs.length === 0) {
      return;
    }

    // Ascending group index; the active tab goes last so its group is appended at the
    // right edge of the layout (see the comment in `restore`).
    const ordered = [...openTabs].sort((a, b) => {
      const aActive = a.active === true ? 1 : 0;
      const bActive = b.active === true ? 1 : 0;
      return aActive - bActive || a.group - b.group;
    });

    for (const tab of ordered) {
      if (token?.isCancellationRequested) {
        return;
      }
      const uri = parseUri(tab.uri);
      if (!uri || !isTrackableUri(uri)) {
        continue;
      }
      try {
        // `preview: false` keeps the tab from being replaced by the next restored file.
        await vscode.commands.executeCommand('vscode.open', uri, {
          viewColumn: tab.group + 1,
          preserveFocus: true,
          preview: false
        });
      } catch (error) {
        logger.debug(`Could not reopen tab ${tab.uri}: ${String(error)}`);
      }
    }
  }

  /** Puts focus back on the tab that was active when the context was captured. */
  private async focusActiveTab(
    openTabs: ContextOpenTab[] | undefined,
    token?: vscode.CancellationToken
  ): Promise<void> {
    const active = openTabs?.find((tab) => tab.active === true);
    if (!active || token?.isCancellationRequested) {
      return;
    }
    const uri = parseUri(active.uri);
    if (!uri) {
      return;
    }
    try {
      await vscode.commands.executeCommand('vscode.open', uri, {
        viewColumn: active.group + 1,
        preview: false
      });
    } catch (error) {
      logger.debug(`Could not focus tab ${active.uri}: ${String(error)}`);
    }
  }

  /**
   * Applies caret/scroll only to editors that are already visible: opening a file just to
   * move a caret would fight `restoreBehavior: keepInTree` and surprise the user.
   */
  private restoreEditorStates(states: ContextEditorState[] | undefined): void {
    if (!states || states.length === 0) {
      return;
    }

    const editors = getVisibleTextEditors();
    if (editors.length === 0) {
      return;
    }

    const byKey = new Map<string, vscode.TextEditor>();
    for (const editor of editors) {
      const uri = editor.document?.uri;
      if (uri) {
        byKey.set(toUriKey(uri), editor);
      }
    }

    for (const state of states) {
      const uri = parseUri(state.uri);
      if (!uri) {
        continue;
      }
      const editor = byKey.get(toUriKey(uri));
      if (!editor) {
        continue;
      }
      this.applyEditorState(editor, state);
    }
  }

  private applyEditorState(editor: vscode.TextEditor, state: ContextEditorState): void {
    try {
      const lineCount = editor.document?.lineCount;
      const maxLine = typeof lineCount === 'number' && lineCount > 0 ? lineCount - 1 : undefined;
      const line = Math.max(0, maxLine === undefined ? state.line : Math.min(state.line, maxLine));

      if (typeof state.scrollLine === 'number') {
        const scrollLine = Math.max(
          0,
          maxLine === undefined ? state.scrollLine : Math.min(state.scrollLine, maxLine)
        );
        // Reveal first: assigning `selection` alone does not scroll the view.
        editor.revealRange(new vscode.Range(scrollLine, 0, scrollLine, 0));
      }

      const columnCount = this.lineLength(editor, line);
      editor.selection = new vscode.Selection(
        line,
        Math.max(0, Math.min(state.character, columnCount)),
        line,
        Math.max(0, Math.min(state.character, columnCount))
      );
    } catch (error) {
      logger.debug(`Could not restore caret for ${state.uri}: ${String(error)}`);
    }
  }

  private lineLength(editor: vscode.TextEditor, line: number): number {
    try {
      return editor.document.lineAt(line).text.length;
    } catch {
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  private captureEditorState(): boolean {
    return vscode.workspace
      .getConfiguration('pin-context')
      .get<boolean>('contexts.captureEditorState', true);
  }

  private captureOpenTabs(): boolean {
    return vscode.workspace
      .getConfiguration('pin-context')
      .get<boolean>('contexts.captureOpenTabs', false);
  }
}
