import * as http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { PinContextAgentService } from './agentApi';

interface BridgeConfig {
  host: '127.0.0.1';
  port: number;
  token: string;
  protocolVersion: 1;
}

const MAX_BODY_BYTES = 1024 * 1024;

export class AgentBridgeServer implements vscode.Disposable {
  private server: http.Server | undefined;
  private token: string | undefined;
  private hostApprovalToken = randomBytes(32).toString('hex');
  private configPath: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly api: PinContextAgentService
  ) {}

  getConfigPath(): string | undefined {
    return this.configPath;
  }

  /** Only the in-editor MCP provider receives this token; it is never persisted to disk. */
  getHostApprovalToken(): string {
    return this.hostApprovalToken;
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.token = randomBytes(32).toString('hex');
    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      await this.stopServer();
      throw new Error('Could not determine the Pin Context agent bridge address.');
    }

    try {
      const storageDir = this.context.storageUri?.fsPath ?? this.context.globalStorageUri.fsPath;
      const name = this.context.storageUri
        ? 'agent-bridge.json'
        : `agent-bridge-${process.pid}.json`;
      this.configPath = path.join(storageDir, name);
      await mkdir(storageDir, { recursive: true });
      const config: BridgeConfig = {
        host: '127.0.0.1',
        port: address.port,
        token: this.token,
        protocolVersion: 1
      };
      await writeFile(this.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      // writeFile's mode option does not alter permissions when replacing an existing file.
      await chmod(this.configPath, 0o600);
      logger.info('Local agent bridge started on loopback.');
    } catch (error) {
      await this.stopServer();
      throw error;
    }
  }

  dispose(): void {
    void this.stopServer();
  }

  private async stopServer(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.configPath) {
      const configPath = this.configPath;
      this.configPath = undefined;
      await rm(configPath, { force: true }).catch((error: unknown) => {
        logger.debug(`Could not remove agent bridge config: ${String(error)}`);
      });
    }
    this.token = undefined;
    this.hostApprovalToken = '';
  }

  private async handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');

    if (request.method !== 'POST' || request.url !== '/v1/tool') {
      this.writeJson(response, 404, { ok: false, error: 'Not found.' });
      return;
    }
    if (!this.isAuthorized(request.headers.authorization)) {
      this.writeJson(response, 401, { ok: false, error: 'Unauthorized.' });
      return;
    }

    try {
      const body = await readJsonBody(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('Request body must be a JSON object.');
      }
      const value = body as Record<string, unknown>;
      if (typeof value.name !== 'string') throw new Error('Missing tool name.');
      const hostApproved = this.isHostApproved(value.hostApprovalToken);
      const result = await this.api.executeTool(value.name, value.arguments ?? {}, {
        origin: hostApproved ? 'vscode-mcp' : 'mcp',
        approvedByHost: hostApproved
      });
      this.writeJson(response, 200, { ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.writeJson(response, 400, { ok: false, error: message });
    }
  }

  private isHostApproved(value: unknown): boolean {
    if (typeof value !== 'string' || !this.hostApprovalToken) return false;
    const provided = Buffer.from(value);
    const expected = Buffer.from(this.hostApprovalToken);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  private isAuthorized(header: string | undefined): boolean {
    if (!this.token || !header?.startsWith('Bearer ')) return false;
    const provided = Buffer.from(header.slice('Bearer '.length));
    const expected = Buffer.from(this.token);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  private writeJson(response: http.ServerResponse, status: number, value: unknown): void {
    if (response.headersSent) return;
    response.statusCode = status;
    response.end(JSON.stringify(value));
  }
}

function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body exceeds 1 MiB.'));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on('error', reject);
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        reject(new Error('Request body is not valid JSON.'));
      }
    });
  });
}
