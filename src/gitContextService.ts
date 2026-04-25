import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitContextInfo {
  workspaceFolder: string;
  branch: string;
  staged: number;
  changed: number;
}

interface CachedGitContextInfo {
  value: GitContextInfo;
  createdAt: number;
}

export class GitContextService implements vscode.Disposable {
  private cache = new Map<string, CachedGitContextInfo>();
  private readonly ttlMs = 3000;

  private readonly disposables: vscode.Disposable[] = [];

  private pollInterval: NodeJS.Timeout | undefined;
  private readonly pollMs = 4000;

  private lastBranches = new Map<string, string>();
  private lastStateHash = new Map<string, string>();

  private readonly onDidChangeBranchEmitter = new vscode.EventEmitter<{
    workspaceFolder: string;
    oldBranch: string;
    newBranch: string;
  }>();

  private readonly onDidChangeStatusEmitter = new vscode.EventEmitter<void>();

  readonly onDidChangeBranch = this.onDidChangeBranchEmitter.event;
  readonly onDidChangeStatus = this.onDidChangeStatusEmitter.event;

  constructor() {
    this.setupWorkspaceTracking();
    this.startPolling();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.stopPolling();

    this.onDidChangeBranchEmitter.dispose();
    this.onDidChangeStatusEmitter.dispose();
  }

  private setupWorkspaceTracking(): void {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.syncWorkspaceState();
      })
    );

    this.syncWorkspaceState();
  }

  private syncWorkspaceState(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];

    const current = new Set(folders.map((f) => f.uri.fsPath));

    for (const key of this.cache.keys()) {
      if (!current.has(key)) {
        this.cache.delete(key);
        this.lastBranches.delete(key);
        this.lastStateHash.delete(key);
      }
    }
  }

  private startPolling(): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(() => {
      void this.pollGitState();
    }, this.pollMs);
  }

  private stopPolling(): void {
    if (!this.pollInterval) return;

    clearInterval(this.pollInterval);
    this.pollInterval = undefined;
  }

  private async pollGitState(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];

    for (const folder of folders) {
      const path = folder.uri.fsPath;

      try {
        const info = await this.getGitInfoForFolder(path);

        const oldBranch = this.lastBranches.get(path);

        if (oldBranch && oldBranch !== info.branch) {
          this.cache.delete(path);

          this.onDidChangeBranchEmitter.fire({
            workspaceFolder: path,
            oldBranch,
            newBranch: info.branch
          });
        }

        this.lastBranches.set(path, info.branch);

        const newHash = `${info.branch}:${info.changed}:${info.staged}`;
        const oldHash = this.lastStateHash.get(path);

        if (oldHash && oldHash !== newHash) {
          this.onDidChangeStatusEmitter.fire();
        }

        this.lastStateHash.set(path, newHash);
      } catch {}
    }
  }

  private async getCurrentBranch(folderPath: string): Promise<string> {
    try {
      const branch = (await this.execGit(['rev-parse', '--abbrev-ref', 'HEAD'], folderPath)).trim();

      return branch || 'detached';
    } catch {
      return 'detached';
    }
  }

  async getCurrentWorkspaceGitContexts(): Promise<GitContextInfo[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];

    const results = await Promise.allSettled(
      folders.map((f) => this.getGitInfoForFolder(f.uri.fsPath))
    );

    return results
      .filter((r): r is PromiseFulfilledResult<GitContextInfo> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  async getGitInfoForFolder(folderPath: string): Promise<GitContextInfo> {
    const cached = this.cache.get(folderPath);
    if (cached && Date.now() - cached.createdAt < this.ttlMs) {
      return cached.value;
    }

    const branch = await this.getCurrentBranch(folderPath);
    const status = await this.execGit(['status', '--porcelain'], folderPath);

    const lines = status.split('\n').filter(Boolean);

    const value: GitContextInfo = {
      workspaceFolder: folderPath,
      branch,
      staged: lines.filter((l) => l[0] !== ' ').length,
      changed: lines.filter((l) => l[1] !== ' ').length
    };

    this.cache.set(folderPath, { value, createdAt: Date.now() });

    return value;
  }

  private async execGit(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout;
  }
}
