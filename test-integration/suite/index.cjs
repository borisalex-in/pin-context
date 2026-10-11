const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, description, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

exports.run = async function run() {
  const extension = vscode.extensions.getExtension('borisalex-in.pin-context');
  assert.ok(extension, 'Pin Context extension is available in the real VS Code Extension Host');

  const api = await extension.activate();
  assert.equal(api.apiVersion, 1, 'public agent API is exposed after activation');
  assert.equal(typeof api.getStatus, 'function');
  assert.equal((await api.getStatus()).mcpProviderRegistered, true, 'native MCP provider registered successfully');
  assert.equal(typeof vscode.lm?.registerMcpServerDefinitionProvider, 'function');

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('pin-context.pinCurrentEditor'));
  assert.ok(commands.includes('pin-context.switchContextById'));
  assert.ok(commands.includes('pin-context.copyAgentMcpConfig'));

  // Exercise the actual bridge configuration command; it must point at the built MCP server
  // and at a live per-workspace bridge configuration, not a test stub.
  await vscode.commands.executeCommand('pin-context.copyAgentMcpConfig');
  const configText = await vscode.env.clipboard.readText();
  const clientConfig = JSON.parse(configText);
  const mcp = clientConfig.mcpServers?.['pin-context'];
  assert.ok(mcp, 'MCP client configuration is copied');
  assert.equal(mcp.command, process.execPath, 'configuration uses the active VS Code runtime');
  assert.equal(mcp.env?.ELECTRON_RUN_AS_NODE, '1');
  const serverIndex = mcp.args?.indexOf('--bridge-config');
  assert.ok(Array.isArray(mcp.args) && serverIndex > 0, 'bridge config path is included');
  assert.ok(fs.existsSync(mcp.args[0]), 'bundled MCP server exists');
  const bridgeConfigPath = mcp.args[serverIndex + 1];
  assert.ok(fs.existsSync(bridgeConfigPath), 'the bridge config exists while VS Code is open');
  const bridgeConfig = JSON.parse(fs.readFileSync(bridgeConfigPath, 'utf8'));
  assert.equal(bridgeConfig.host, '127.0.0.1');
  assert.equal(typeof bridgeConfig.port, 'number');
  assert.match(bridgeConfig.token, /^[a-f0-9]{64}$/);

  // Real VS Code workflow: pin a file on one Git branch, switch away, then return and
  // verify that the saved branch context restores that file's pin.
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'the temporary Git workspace is open');
  const fixtureUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, 'fixture.ts'));
  const document = await vscode.workspace.openTextDocument(fixtureUri);
  await vscode.window.showTextDocument(document);

  await waitFor(async () => {
    const contexts = await api.listContexts();
    const active = await api.getActiveContext();
    return contexts.some((context) => context.source === 'git' && context.branch === 'main') && active?.branch === 'main';
  }, 'the initial main branch context to become active');
  await vscode.commands.executeCommand('pin-context.pinCurrentEditor');
  await waitFor(async () => (await api.getPinnedFiles()).some((file) => file.uri === fixtureUri.toString()), 'the fixture to be pinned');

  execFileSync('git', ['switch', '-c', 'integration-empty'], { cwd: workspaceFolder.uri.fsPath, stdio: 'ignore' });
  try {
    await waitFor(
      async () => (await api.getActiveContext())?.branch === 'integration-empty',
      'automatic switch to the second branch context'
    );
  } catch (error) {
    const contexts = await api.listContexts();
    const active = await api.getActiveContext();
    let actualGitBranch = 'unavailable';
    try {
      actualGitBranch = execFileSync('git', ['branch', '--show-current'], {
        cwd: workspaceFolder.uri.fsPath,
        encoding: 'utf8'
      }).trim();
    } catch {}
    error.message += `\nDiagnostic state after first branch switch: ${JSON.stringify({
      actualGitBranch,
      active,
      contexts: contexts.map((context) => ({
        id: context.id,
        branch: context.branch,
        source: context.source,
        pinnedFileCount: context.pinnedFileCount
      }))
    }, null, 2)}`;
    throw error;
  }

  // The newly created Git context inherits the current pins by design. Unpin there so
  // switching back proves that the original branch's saved pins are restored.
  await vscode.commands.executeCommand('pin-context.unpinCurrentEditor');
  await waitFor(async () => (await api.getPinnedFiles()).every((file) => file.uri !== fixtureUri.toString()), 'the fixture to be unpinned on the second branch');

  execFileSync('git', ['switch', 'main'], { cwd: workspaceFolder.uri.fsPath, stdio: 'ignore' });
  await waitFor(async () => (await api.getActiveContext())?.branch === 'main', 'automatic switch back to main');
  try {
    await waitFor(
      async () => (await api.getPinnedFiles()).some((file) => file.uri === fixtureUri.toString()),
      'the saved fixture pin to be restored on main'
    );
  } catch (error) {
    const contexts = await api.listContexts();
    const active = await api.getActiveContext();
    const livePins = await api.getPinnedFiles();
    const main = contexts.find((context) => context.source === 'git' && context.branch === 'main');
    const empty = contexts.find((context) => context.source === 'git' && context.branch === 'integration-empty');
    error.message += `\nDiagnostic state: ${JSON.stringify({
      active,
      mainContext: main,
      emptyContext: empty,
      livePinnedFiles: livePins.map((file) => file.uri),
      expectedFixtureUri: fixtureUri.toString()
    }, null, 2)}`;
    throw error;
  }
};
