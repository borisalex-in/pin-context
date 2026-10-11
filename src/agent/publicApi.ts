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
  /** Present for the active context; contains its saved pin set, not file contents. */
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
 * Public extension API. Read methods are side-effect-free. executeTool prompts before every
 * state-changing call; clients must not treat tool invocation as approval.
 */
export interface PinContextAgentApi {
  readonly apiVersion: 1;
  getStatus(): Promise<PinContextAgentStatus>;
  getActiveContext(): Promise<PinContextAgentContextSummary | null>;
  listContexts(): Promise<PinContextAgentContextSummary[]>;
  getPinnedFiles(contextId?: string): Promise<PinContextAgentFile[]>;
  getWorkspaceInfo(): Promise<PinContextAgentWorkspaceFolder[]>;
  executeTool(name: PinContextAgentToolName, input?: Record<string, unknown>): Promise<unknown>;
}
