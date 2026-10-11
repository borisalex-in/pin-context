import * as fs from 'node:fs';
import * as http from 'node:http';
import * as readline from 'node:readline';
import { AGENT_TOOL_DEFINITIONS } from './toolDefinitions';

interface BridgeConfig {
  host: string;
  port: number;
  token: string;
  protocolVersion: number;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const SERVER_VERSION = process.env.PIN_CONTEXT_VERSION ?? '0.0.0';
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function readBridgeConfig(): BridgeConfig {
  const argumentIndex = process.argv.indexOf('--bridge-config');
  const configPath =
    argumentIndex >= 0 ? process.argv[argumentIndex + 1] : process.env.PIN_CONTEXT_BRIDGE_CONFIG;
  if (!configPath) throw new Error('Missing --bridge-config path for the Pin Context MCP server.');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<BridgeConfig>;
  if (
    raw.host !== '127.0.0.1' ||
    !Number.isInteger(raw.port) ||
    (raw.port ?? 0) < 1 ||
    (raw.port ?? 0) > 65535 ||
    typeof raw.token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.token)
  ) {
    throw new Error('The Pin Context agent bridge configuration is invalid or expired.');
  }
  return raw as BridgeConfig;
}

const bridgeConfig = readBridgeConfig();
const toolDefinitions = AGENT_TOOL_DEFINITIONS.map((tool) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: tool.inputSchema,
  annotations: {
    title: tool.title,
    readOnlyHint: tool.readOnly,
    destructiveHint: Boolean(tool.destructive),
    idempotentHint:
      tool.readOnly ||
      tool.name === 'pin_context_pin_files' ||
      tool.name === 'pin_context_unpin_files',
    openWorldHint: false
  }
}));

function send(message: Record<string, unknown>): void {
  // MCP stdio transport writes one JSON-RPC message per line. Keep stdout protocol-only.
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function rpcError(
  id: JsonRpcRequest['id'],
  code: number,
  message: string
): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function callBridge(name: string, args: unknown): Promise<unknown> {
  const requestBody: Record<string, unknown> = { name, arguments: args ?? {} };
  // This secret is injected only by the in-editor provider. Client-supplied MCP config
  // never contains it, so external clients must use Pin Context's own approval dialog.
  const hostApprovalToken = process.env.PIN_CONTEXT_HOST_APPROVAL;
  if (hostApprovalToken) requestBody.hostApprovalToken = hostApprovalToken;
  const body = Buffer.from(JSON.stringify(requestBody));
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: bridgeConfig.host,
        port: bridgeConfig.port,
        method: 'POST',
        path: '/v1/tool',
        headers: {
          Authorization: `Bearer ${bridgeConfig.token}`,
          'Content-Type': 'application/json',
          'Content-Length': body.length
        },
        timeout: 900_000
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        );
        response.on('error', reject);
        response.on('end', () => {
          let parsed: { ok?: boolean; result?: unknown; error?: string };
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof parsed;
          } catch {
            reject(new Error('Pin Context returned an invalid response.'));
            return;
          }
          if (response.statusCode !== 200 || parsed.ok !== true) {
            reject(
              new Error(
                parsed.error ?? `Pin Context bridge returned HTTP ${response.statusCode ?? 500}.`
              )
            );
            return;
          }
          resolve(parsed.result);
        });
      }
    );
    request.on('timeout', () =>
      request.destroy(new Error('Timed out waiting for Pin Context user confirmation.'))
    );
    request.on('error', reject);
    request.end(body);
  });
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    if (request.id !== undefined) send(rpcError(request.id, -32600, 'Invalid JSON-RPC request.'));
    return;
  }
  const id = request.id;
  const hasId = id !== undefined;
  const params = request.params ?? {};
  try {
    let result: unknown;
    switch (request.method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        const version =
          typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : '2025-03-26';
        result = {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'pin-context', version: SERVER_VERSION },
          instructions:
            'Pin Context manages the developer-selected workspace context and pinned files. Before editing, call pin_context_get_status or pin_context_get_active_context and treat the active context as developer intent, not as the complete scope of the task. Pinned-file tools return paths and URIs, not file contents; read file contents through your own workspace tools. Use exact context IDs from pin_context_list_contexts. State-changing tools always require user approval, and a cancelled operation must not be retried without a new user request.'
        };
        break;
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools: toolDefinitions };
        break;
      case 'tools/call': {
        if (typeof params.name !== 'string') {
          result = {
            isError: true,
            content: [{ type: 'text', text: 'tools/call requires a tool name.' }]
          };
          break;
        }
        const definition = AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === params.name);
        if (!definition) {
          result = {
            isError: true,
            content: [{ type: 'text', text: `Unknown Pin Context tool “${params.name}”.` }]
          };
          break;
        }
        try {
          const data = await callBridge(definition.name, params.arguments ?? {});
          result = { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
          result = {
            isError: true,
            content: [
              { type: 'text', text: error instanceof Error ? error.message : String(error) }
            ]
          };
        }
        break;
      }
      default:
        if (!hasId) return;
        send(rpcError(id, -32601, `Method not found: ${request.method}`));
        return;
    }
    if (hasId) send({ jsonrpc: '2.0', id, result });
  } catch (error) {
    if (hasId) send(rpcError(id, -32603, error instanceof Error ? error.message : String(error)));
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    send(rpcError(null, -32700, 'Parse error.'));
    return;
  }
  void handleRequest(request);
});
input.on('close', () => process.exit(0));
