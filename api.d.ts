import type * as vscode from 'vscode';

export type PinContextAgentToolName =
  | 'pin_context_get_status'
  | 'pin_context_get_active_context'
  | 'pin_context_list_contexts'
  | 'pin_context_get_pinned_files'
  | 'pin_context_get_workspace_info'
  | 'pin_context_switch_context'
  | 'pin_context_create_context'
  | 'pin_context_save_context'
  | 'pin_context_rename_context'
  | 'pin_context_delete_context'
  | 'pin_context_pin_files'
  | 'pin_context_unpin_files';

export interface PinContextAgentFile {
  path: string;
  uri: string;
  /** True when the file is part of the returned live or saved pin set. */
  pinned: boolean;
}

export interface PinContextAgentContextSummary {
  id: string;
  name: string;
  source: 'manual' | 'git' | 'repo';
  active: boolean;
  pinnedFileCount: number;
  branch?: string;
  unstagedChanges?: number;
  stagedChanges?: number;
  workspaceFolder?: string;
  updatedAt: number;
  /** Present for the active context; contains the saved pinned-file list, not file contents. */
  pinnedFiles?: PinContextAgentFile[];
}

export interface PinContextAgentWorkspaceFolder {
  name: string;
  path: string;
  uri: string;
}

export interface PinContextAgentStatus {
  version: 1;
  activeContext: PinContextAgentContextSummary | null;
  pinnedFileCount: number;
  contextCount: number;
  workspaceFolders: PinContextAgentWorkspaceFolder[];
}

/** Public API returned by `vscode.extensions.getExtension('borisalex-in.pin-context').activate()`. */
export interface PinContextAgentApi {
  readonly apiVersion: 1;
  getStatus(): Promise<PinContextAgentStatus>;
  getActiveContext(): Promise<PinContextAgentContextSummary | null>;
  listContexts(): Promise<PinContextAgentContextSummary[]>;
  getPinnedFiles(contextId?: string): Promise<PinContextAgentFile[]>;
  getWorkspaceInfo(): Promise<PinContextAgentWorkspaceFolder[]>;
  /** State-changing tools always require user approval. */
  executeTool(name: PinContextAgentToolName, input?: Record<string, unknown>): Promise<unknown>;
}

/** Returned by the extension's activation function. */
export declare function activate(context: vscode.ExtensionContext): Promise<PinContextAgentApi>;
export declare function deactivate(): void;
