import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentBridgeServer } from './bridge';

const MCP_PROVIDER_ID = 'pin-context-mcp';

export function registerMcpServerProvider(
  context: vscode.ExtensionContext,
  bridge: AgentBridgeServer,
  version: string
): vscode.Disposable {
  const definitionsChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(definitionsChanged);
  const serverPath = path.join(context.extensionPath, 'out', 'mcp-server.js');

  const registration = vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
    onDidChangeMcpServerDefinitions: definitionsChanged.event,
    provideMcpServerDefinitions: async () => {
      const configPath = bridge.getConfigPath();
      if (!configPath) return [];
      const server = new vscode.McpStdioServerDefinition(
        'Pin Context',
        process.execPath,
        [serverPath, '--bridge-config', configPath],
        {
          PIN_CONTEXT_VERSION: version,
          PIN_CONTEXT_HOST_APPROVAL: bridge.getHostApprovalToken()
        },
        version
      );
      server.cwd = vscode.Uri.file(context.extensionPath);
      return [server];
    },
    resolveMcpServerDefinition: async (server) => server
  });

  context.subscriptions.push(registration);
  return registration;
}
