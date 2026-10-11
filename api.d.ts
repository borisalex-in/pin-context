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
  /** True only after the native VS Code MCP server-definition provider registered successfully. */
  mcpProviderRegistered: boolean;
  workspaceFolders: PinContextAgentWorkspaceFolder[];
}

/**
 * Public API returned by `vscode.extensions.getExtension('borisalex-in.pin-context').activate()`.
 *
 * Compatibility policy: beginning with Pin Context 1.0.0, this declaration is a stable public
 * contract. Patch releases preserve API shape and semantics; minor releases may add backwards-
 * compatible members and tool names; breaking changes require a major release. MCP tool names,
 * input schemas, and existing result semantics follow the same policy.
 */
export interface PinContextAgentApi {
  readonly apiVersion: 1;
  getStatus(): Promise<PinContextAgentStatus>;
  getActiveContext(): Promise<PinContextAgentContextSummary | null>;
  listContexts(): Promise<PinContextAgentContextSummary[]>;
  getPinnedFiles(contextId?: string): Promise<PinContextAgentFile[]>;
  getWorkspaceInfo(): Promise<PinContextAgentWorkspaceFolder[]>;
  /**
   * Invoke a Pin Context tool. State-changing operations display an explicit approval prompt;
   * callers must not treat this method invocation as user consent.
   */
  executeTool(name: PinContextAgentToolName, input?: Record<string, unknown>): Promise<unknown>;
}

/** Returned by the extension's activation function. */
export declare function activate(context: vscode.ExtensionContext): Promise<PinContextAgentApi>;
export declare function deactivate(): void;
