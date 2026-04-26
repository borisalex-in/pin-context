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
  private readonly activePollMs = 4000;
  private readonly idlePollMs = 12000;
  private currentPollMs = this.activePollMs;
  private unchangedPollCycles = 0;
  private readonly visibilityDisposable: vscode.Disposable;
  private readonly configDisposable: vscode.Disposable;

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
    this.visibilityDisposable = vscode.window.onDidChangeWindowState(() => {
      this.updatePollingState();
    });
    this.configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('pin-context.contexts.autoGitContexts')) {
        this.updatePollingState();
      }
    });
    this.updatePollingState();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.visibilityDisposable.dispose();
    this.configDisposable.dispose();
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

    this.updatePollingState();
  }

  private startPolling(): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(() => {
      void this.pollGitState();
    }, this.currentPollMs);
  }

  private stopPolling(): void {
    if (!this.pollInterval) return;

    clearInterval(this.pollInterval);
    this.pollInterval = undefined;
  }

  private restartPolling(nextIntervalMs: number): void {
    if (this.currentPollMs === nextIntervalMs && this.pollInterval) {
      return;
    }
    this.currentPollMs = nextIntervalMs;
    this.stopPolling();
    this.startPolling();
  }

  private updatePollingState(): void {
    if (this.shouldPoll()) {
      this.restartPolling(this.currentPollMs);
      return;
    }
    this.unchangedPollCycles = 0;
    this.currentPollMs = this.activePollMs;
    this.stopPolling();
  }

  private shouldPoll(): boolean {
    const autoGitContexts = vscode.workspace
      .getConfiguration('pin-context')
      .get<boolean>('contexts.autoGitContexts', true);
    const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    return autoGitContexts && hasWorkspace && vscode.window.state.focused;
  }

  private async pollGitState(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    let hasStateChange = false;

    for (const folder of folders) {
      const path = folder.uri.fsPath;

      try {
        const info = await this.getGitInfoForFolder(path);

        const oldBranch = this.lastBranches.get(path);

        if (oldBranch && oldBranch !== info.branch) {
          this.cache.delete(path);
          hasStateChange = true;

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
          hasStateChange = true;
          this.onDidChangeStatusEmitter.fire();
        }

        this.lastStateHash.set(path, newHash);
      } catch {}
    }

    if (hasStateChange) {
      this.unchangedPollCycles = 0;
      this.restartPolling(this.activePollMs);
      return;
    }

    this.unchangedPollCycles += 1;
    if (this.unchangedPollCycles >= 3) {
      this.restartPolling(this.idlePollMs);
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
    const [changedRaw, stagedRaw] = await Promise.all([
      this.execGit(['diff', '--name-only'], folderPath),
      this.execGit(['diff', '--cached', '--name-only'], folderPath)
    ]);

    const value: GitContextInfo = {
      workspaceFolder: folderPath,
      branch,
      staged: this.countLines(stagedRaw),
      changed: this.countLines(changedRaw)
    };

    this.cache.set(folderPath, { value, createdAt: Date.now() });

    return value;
  }

  private async execGit(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout;
  }

  private countLines(raw: string): number {
    if (!raw.trim()) {
      return 0;
    }
    return raw.split('\n').filter(Boolean).length;
  }
}
