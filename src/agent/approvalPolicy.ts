export interface AgentApprovalOptions {
  origin?: 'mcp' | 'extension-api' | 'vscode-mcp';
  approvedByHost?: boolean;
  requireOwnConfirmation?: boolean;
}

/**
 * Trust VS Code's MCP approval for ordinary mutations, but never delegate approval of
 * destructive operations to a host-level "Always allow" setting.
 */
export function canRelyOnHostApproval(options: AgentApprovalOptions): boolean {
  return (
    options.origin === 'vscode-mcp' &&
    options.approvedByHost === true &&
    options.requireOwnConfirmation !== true
  );
}
