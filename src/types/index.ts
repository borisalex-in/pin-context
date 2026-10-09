import * as vscode from 'vscode';

export type ContextSource = 'manual' | 'git' | 'repo';

/** Cursor and scroll position of one file, so a context can restore "where I stopped". */
export interface ContextEditorState {
  uri: string;
  /** 0-based line of the cursor. */
  line: number;
  /** 0-based character of the cursor. */
  character: number;
  /** 0-based first visible line of the editor. */
  scrollLine?: number;
}

/** A tab that was open but not pinned when the context was captured. */
export interface ContextOpenTab {
  uri: string;
  /** Index of the editor group the tab belonged to (0-based). */
  group: number;
  active?: boolean;
}

export interface PinContext {
  id: string;
  name: string;
  source: ContextSource;
  workspaceFolder?: string;
  branch?: string;
  /** Git contexts only: number of files with unstaged changes. */
  changed?: number;
  /** Git contexts only: number of files with staged changes. */
  staged?: number;
  pinnedUris: string[];
  /** Working set: caret/scroll positions of the files that were visible. */
  editorStates?: ContextEditorState[];
  /** Working set: tabs that were open but not pinned. */
  openTabs?: ContextOpenTab[];
  createdAt: number;
  updatedAt: number;
}

export type TimelineAction = 'switch' | 'save' | 'create' | 'restore';

export interface ContextTimelineEntry {
  id: string;
  contextId: string;
  contextName: string;
  timestamp: number;
  action: TimelineAction;
}

export interface ContextSnapshot {
  contexts: PinContext[];
  activeContextId?: string;
  lastActiveContextId?: string;
  timeline: ContextTimelineEntry[];
}

export interface ContextQuickPickItem extends vscode.QuickPickItem {
  contextId: string;
}
