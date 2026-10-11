import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import ts from 'typescript';

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function transpile(sourcePath: string, outputPath: string): void {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    reportDiagnostics: true
  });
  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  );
  assert.equal(
    errors.length,
    0,
    `Could not transpile ${sourcePath}: ${errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ')}`
  );
  fs.writeFileSync(outputPath, result.outputText);
}

function waitForResponse(
  child: ChildProcessWithoutNullStreams,
  lines: ReturnType<typeof createInterface>,
  id: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for MCP response to ${method}.`));
    }, 5000);

    const onLine = (line: string): void => {
      let response: JsonRpcResponse;
      try {
        response = JSON.parse(line) as JsonRpcResponse;
      } catch {
        cleanup();
        reject(new Error(`MCP server wrote non-JSON output to stdout: ${line}`));
        return;
      }
      if (response.id !== id) return;
      cleanup();
      resolve(response);
    };

    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`MCP server exited before ${method} completed (code ${String(code)}).`));
    };

    const cleanup = (): void => {
      clearTimeout(timeout);
      lines.off('line', onLine);
      child.off('exit', onExit);
    };

    lines.on('line', onLine);
    child.once('exit', onExit);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

test('standalone MCP server negotiates, exposes the shared tools, and forwards calls without bypass tokens', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-context-mcp-test-'));
  const sourceRoot = path.join(__dirname, '..', 'src', 'agent');
  const serverScript = path.join(tempDir, 'mcpServer.js');
  const definitionsScript = path.join(tempDir, 'toolDefinitions.js');
  const configPath = path.join(tempDir, 'bridge.json');
  const token = 'a'.repeat(64);
  const bridgeRequests: Array<Record<string, unknown>> = [];

  const bridge = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      bridgeRequests.push(
        JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      );
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ok: true, result: { active: 'test-context' } }));
    });
  });

  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    transpile(path.join(sourceRoot, 'toolDefinitions.ts'), definitionsScript);
    transpile(path.join(sourceRoot, 'mcpServer.ts'), serverScript);

    await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
    const address = bridge.address();
    assert.ok(address && typeof address !== 'string');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ host: '127.0.0.1', port: address.port, token, protocolVersion: 1 })
    );

    const env = { ...process.env };
    delete env.PIN_CONTEXT_HOST_APPROVAL;
    child = spawn(process.execPath, [serverScript, '--bridge-config', configPath], {
      cwd: tempDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const lines = createInterface({ input: child.stdout });
    const stderr: string[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));

    const initialized = await waitForResponse(child, lines, 1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0' }
    });
    assert.equal(initialized.result?.protocolVersion, '2025-06-18');
    assert.equal((initialized.result?.serverInfo as Record<string, unknown>).name, 'pin-context');
    assert.match(String(initialized.result?.instructions), /pin_context_get_active_context/);

    const listed = await waitForResponse(child, lines, 2, 'tools/list');
    const tools = (listed.result?.tools ?? []) as Array<Record<string, unknown>>;
    assert.equal(tools.length, 12);
    const writeTool = tools.find((tool) => tool.name === 'pin_context_pin_files');
    assert.equal((writeTool?.annotations as Record<string, unknown>).readOnlyHint, false);
    assert.equal((writeTool?.annotations as Record<string, unknown>).destructiveHint, false);

    const called = await waitForResponse(child, lines, 3, 'tools/call', {
      name: 'pin_context_get_status',
      arguments: {}
    });
    assert.equal(bridgeRequests.length, 1);
    assert.equal(bridgeRequests[0].name, 'pin_context_get_status');
    assert.equal(
      'hostApprovalToken' in bridgeRequests[0],
      false,
      'external MCP calls cannot claim VS Code host approval'
    );
    assert.deepEqual(called.result?.content, [
      { type: 'text', text: JSON.stringify({ active: 'test-context' }, null, 2) }
    ]);
    assert.equal(
      'structuredContent' in (called.result ?? {}),
      false,
      'keep responses compatible with older MCP protocol versions'
    );

    const unknown = await waitForResponse(child, lines, 4, 'tools/call', {
      name: 'unknown_tool',
      arguments: {}
    });
    assert.equal(unknown.result?.isError, true);
    assert.equal(bridgeRequests.length, 1, 'unknown tools are rejected before reaching the bridge');

    child.stdin.end();
    await new Promise<void>((resolve) => child?.once('exit', () => resolve()));
    child = undefined;
    lines.close();
  } finally {
    if (child) {
      child.kill();
      await new Promise<void>((resolve) => child?.once('exit', () => resolve()));
    }
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
