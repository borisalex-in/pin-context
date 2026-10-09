import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { logger } from '../utils/logger';
import { parseGitStatus } from '../utils/gitStatus';
import { GitApiSource, normalizeGitPath } from './gitApiSource';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 8000;
const GIT_MAX_BUFFER = 20 * 1024 * 1024;
const NOT_A_REPO_RETRY_MS = 30000;
// Fallback-only cadence. The timer runs solely when the vscode.git API is unavailable,
// so a coarser 15 s interval is fine: branch switches via the API are instant and the
// slower counters do not justify spawning `git status` every few seconds.
const FALLBACK_POLL_MS = 15000;

export interface GitContextInfo {
  workspaceFolder: string;
  branch: string;
  staged: number;
  changed: number;
}

export interface GitBranchChange {
  workspaceFolder: string;
  oldBranch: string;
  newBranch: string;
}

interface CachedGitContextInfo {
  value: GitContextInfo;
  createdAt: number;
}

class NotAGitRepositoryError extends Error {
  constructor(folder: string) {
    super(`Not a git repository: ${folder}`);
  }
}

export class GitContextService implements vscode.Disposable {
  private readonly cache = new Map<string, CachedGitContextInfo>();
  private readonly inflight = new Map<string, Promise<GitContextInfo>>();
  private readonly notRepoUntil = new Map<string, number>();
  private readonly ttlMs = 3000;

  private readonly disposables: vscode.Disposable[] = [];

  private pollInterval: NodeJS.Timeout | undefined;
  private polling = false;
  private disposed = false;
  private gitMissing = false;

  private apiSource: GitApiSource | undefined;
  private apiSourcePromise: Promise<void> | undefined;
  private apiActive = false;
  private apiRefreshRunning = false;

  private readonly lastBranches = new Map<string, string>();
  private readonly lastStateHash = new Map<string, string>();

  private readonly onDidChangeBranchEmitter = new vscode.EventEmitter<GitBranchChange>();
  private readonly onDidChangeStatusEmitter = new vscode.EventEmitter<void>();

  readonly onDidChangeBranch = this.onDidChangeBranchEmitter.event;
  readonly onDidChangeStatus = this.onDidChangeStatusEmitter.event;

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.syncWorkspaceState()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.initGitApiSource();
        this.updatePollingState();
        this.catchUpFromApiSource();
      }),
      vscode.window.onDidChangeWindowState((state) => {
        this.updatePollingState();
        if (!state.focused) {
          return;
        }
        // The branch may have been switched while the window was in the background.
        if (this.apiActive) {
          this.catchUpFromApiSource();
        } else if (this.shouldPoll()) {
          void this.pollGitState();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('pin-context.contexts.autoGitContexts')) {
          this.updatePollingState();
          this.catchUpFromApiSource();
        }
      })
    );

    this.initGitApiSource();
    this.syncWorkspaceState();
  }

  dispose(): void {
    this.disposed = true;
    this.stopPolling();
    this.disposables.forEach((d) => d.dispose());
    this.onDidChangeBranchEmitter.dispose();
    this.onDidChangeStatusEmitter.dispose();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async getCurrentWorkspaceGitContexts(): Promise<GitContextInfo[]> {
    const results = await Promise.allSettled(
      this.getEligibleFolders().map((folder) => this.getGitInfoForFolder(folder))
    );

    return results
      .filter((r): r is PromiseFulfilledResult<GitContextInfo> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  async getGitInfoForFolder(folderPath: string, force = false): Promise<GitContextInfo> {
    const apiInfo = this.getGitApiInfo(folderPath);
    if (apiInfo) {
      // First observation seeds the diff state; later events report only deltas.
      if (!this.lastBranches.has(folderPath)) {
        this.lastBranches.set(folderPath, apiInfo.branch);
      }
      return apiInfo;
    }

    if (this.gitMissing) {
      throw new Error('git executable not found');
    }

    const retryAt = this.notRepoUntil.get(folderPath);
    if (retryAt && retryAt > Date.now() && !force) {
      throw new NotAGitRepositoryError(folderPath);
    }

    if (!force) {
      const cached = this.cache.get(folderPath);
      if (cached && Date.now() - cached.createdAt < this.ttlMs) {
        return cached.value;
      }
    }

    const pending = this.inflight.get(folderPath);
    if (pending) {
      return pending;
    }

    const promise = this.readGitInfo(folderPath)
      .then((value) => {
        this.notRepoUntil.delete(folderPath);
        this.cache.set(folderPath, { value, createdAt: Date.now() });
        if (!this.lastBranches.has(folderPath)) {
          this.lastBranches.set(folderPath, value.branch);
        }
        return value;
      })
      .catch((error: unknown) => {
        if (error instanceof NotAGitRepositoryError) {
          this.notRepoUntil.set(folderPath, Date.now() + NOT_A_REPO_RETRY_MS);
        }
        throw error;
      })
      .finally(() => {
        this.inflight.delete(folderPath);
      });

    this.inflight.set(folderPath, promise);
    return promise;
  }

  /**
   * Names of the local branches of a repository. Never throws: an empty array means
   * "unknown" (untrusted workspace, no repository, git failure) and the reason is
   * only debug-logged.
   */
  async getLocalBranches(folderPath: string): Promise<string[]> {
    const apiBranches = this.apiSource?.getLocalBranches(folderPath);
    if (apiBranches) {
      return apiBranches;
    }

    if (!this.isEligibleFolderPath(folderPath)) {
      return [];
    }

    try {
      const stdout = await this.execGit(
        ['branch', '--list', '--format=%(refname:short)'],
        folderPath
      );
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch (error) {
      logger.debug(`git branch list failed for ${folderPath}: ${String(error)}`);
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // vscode.git API source
  // ---------------------------------------------------------------------------

  /**
   * Activates the built-in `vscode.git` extension and, once available, takes branch and
   * counters from its API instead of running `git status` on a timer. Skipped while the
   * workspace is untrusted: activating the git extension can run git, and repository
   * config may execute arbitrary commands.
   */
  private initGitApiSource(): void {
    if (this.disposed || this.apiSourcePromise || !vscode.workspace.isTrusted) {
      return;
    }

    const source = new GitApiSource();
    this.apiSourcePromise = source
      .tryInitialize()
      .then((ok) => {
        if (!ok || this.disposed) {
          source.dispose();
          return;
        }
        this.apiSource = source;
        this.apiActive = true;
        this.disposables.push(
          source,
          source.onDidChange(() => this.handleGitApiChange())
        );
        // The fallback timer only makes sense while the API source is unavailable.
        this.stopPolling();
        this.catchUpFromApiSource();
      })
      .catch((error: unknown) => {
        logger.debug(`vscode.git API initialization failed: ${String(error)}`);
        source.dispose();
      });
  }

  private getGitApiInfo(folderPath: string): GitContextInfo | undefined {
    const snapshot = this.apiSource?.getSnapshot(folderPath);
    if (!snapshot) {
      return undefined;
    }
    return {
      workspaceFolder: folderPath,
      branch: snapshot.branch,
      staged: snapshot.staged,
      changed: snapshot.changed
    };
  }

  private handleGitApiChange(): void {
    if (!this.shouldTrackGit()) {
      return;
    }
    this.refreshFromApiSource();
  }

  private catchUpFromApiSource(): void {
    if (!this.apiActive || !this.shouldTrackGit()) {
      return;
    }
    this.refreshFromApiSource();
  }

  /**
   * Snapshot reads are synchronous, so the whole diff runs in one pass; the guard only
   * protects against re-entrance through listeners.
   */
  private refreshFromApiSource(): void {
    if (this.apiRefreshRunning) {
      return;
    }
    this.apiRefreshRunning = true;
    try {
      for (const folderPath of this.getEligibleFolders()) {
        const info = this.getGitApiInfo(folderPath);
        if (info) {
          this.applyGitInfo(info);
        }
      }
    } finally {
      this.apiRefreshRunning = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Git access
  // ---------------------------------------------------------------------------

  /**
   * One `git status` call gives branch + staged/changed counters.
   * Previously this took three separate processes per folder on every poll.
   */
  private async readGitInfo(folderPath: string): Promise<GitContextInfo> {
    let stdout: string;
    try {
      stdout = await this.execGit(['status', '--porcelain=v1', '--branch', '-uno'], folderPath);
    } catch (error) {
      if (this.isNotRepositoryError(error)) {
        throw new NotAGitRepositoryError(folderPath);
      }
      throw error;
    }

    const parsed = parseGitStatus(stdout);
    let branch = parsed.branch;

    if (!branch) {
      try {
        const sha = (await this.execGit(['rev-parse', '--short', 'HEAD'], folderPath)).trim();
        branch = sha ? `detached@${sha}` : 'detached';
      } catch {
        branch = 'detached';
      }
    }

    return {
      workspaceFolder: folderPath,
      branch,
      staged: parsed.staged,
      changed: parsed.changed
    };
  }

  private async execGit(args: string[], cwd: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        env: {
          ...process.env,
          // Do not take index.lock: polling must never interfere with the user's own git commands.
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C'
        }
      });
      return stdout;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        // Node reports ENOENT both for a missing `git` binary and for a missing `cwd`
        // (for example a workspace folder that was deleted). Only the former is fatal.
        if (!existsSync(cwd)) {
          throw new NotAGitRepositoryError(cwd);
        }
        if (!this.gitMissing) {
          this.gitMissing = true;
          logger.warn('git executable was not found; git contexts are disabled.');
          this.stopPolling();
        }
      }
      throw error;
    }
  }

  private isNotRepositoryError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /not a git repository/i.test(message);
  }

  // ---------------------------------------------------------------------------
  // State diffing
  // ---------------------------------------------------------------------------

  private applyGitInfo(info: GitContextInfo): void {
    const folderPath = info.workspaceFolder;

    const oldBranch = this.lastBranches.get(folderPath);
    this.lastBranches.set(folderPath, info.branch);

    if (oldBranch && oldBranch !== info.branch) {
      this.onDidChangeBranchEmitter.fire({
        workspaceFolder: folderPath,
        oldBranch,
        newBranch: info.branch
      });
    }

    const newHash = `${info.branch}:${info.changed}:${info.staged}`;
    const oldHash = this.lastStateHash.get(folderPath);
    this.lastStateHash.set(folderPath, newHash);

    if (oldHash && oldHash !== newHash) {
      this.onDidChangeStatusEmitter.fire();
    }
  }

  // ---------------------------------------------------------------------------
  // Guards and polling (CLI fallback)
  // ---------------------------------------------------------------------------

  /**
   * Running `git` inside an untrusted workspace is unsafe: repository config
   * (for example `core.fsmonitor`) can execute arbitrary commands.
   */
  private getEligibleFolders(): string[] {
    if (!vscode.workspace.isTrusted) {
      return [];
    }
    return (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === 'file')
      .map((folder) => folder.uri.fsPath);
  }

  /** Guards `getLocalBranches`: a file-scheme workspace folder (or a path inside one). */
  private isEligibleFolderPath(folderPath: string): boolean {
    if (!vscode.workspace.isTrusted) {
      return false;
    }
    const folder = normalizeGitPath(folderPath);
    return this.getEligibleFolders().some((eligible) => {
      const root = normalizeGitPath(eligible);
      return folder === root || folder.startsWith(`${root}/`);
    });
  }

  private syncWorkspaceState(): void {
    const current = new Set(this.getEligibleFolders());

    for (const map of [this.cache, this.lastBranches, this.lastStateHash, this.notRepoUntil]) {
      for (const key of [...map.keys()]) {
        if (!current.has(key)) {
          map.delete(key);
        }
      }
    }

    this.updatePollingState();
  }

  private startPolling(): void {
    if (this.pollInterval || this.disposed) {
      return;
    }
    this.pollInterval = setInterval(() => {
      void this.pollGitState();
    }, FALLBACK_POLL_MS);
  }

  private stopPolling(): void {
    if (!this.pollInterval) {
      return;
    }
    clearInterval(this.pollInterval);
    this.pollInterval = undefined;
  }

  private updatePollingState(): void {
    if (this.shouldPoll()) {
      this.startPolling();
    } else {
      this.stopPolling();
    }
  }

  /**
   * Timer polling is the fallback for when the vscode.git API is unavailable (extension
   * missing, disabled or failed to activate). While the API drives updates, its events
   * are instant and no subprocess is needed.
   */
  private shouldPoll(): boolean {
    return this.shouldTrackGit() && !this.apiActive;
  }

  /** All conditions under which git state may be observed and events may be emitted. */
  private shouldTrackGit(): boolean {
    if (this.disposed || this.gitMissing) {
      return false;
    }
    const autoGitContexts = vscode.workspace
      .getConfiguration('pin-context')
      .get<boolean>('contexts.autoGitContexts', true);
    return autoGitContexts && this.getEligibleFolders().length > 0 && vscode.window.state.focused;
  }

  private async pollGitState(): Promise<void> {
    // setInterval does not wait for async work: never run two polls at once.
    if (this.polling || this.disposed) {
      return;
    }
    this.polling = true;

    try {
      for (const folderPath of this.getEligibleFolders()) {
        if (this.disposed) {
          return;
        }
        let info: GitContextInfo;
        try {
          info = await this.getGitInfoForFolder(folderPath, true);
        } catch (error) {
          logger.debug(`Git poll skipped for ${folderPath}: ${String(error)}`);
          continue;
        }
        this.applyGitInfo(info);
      }
    } finally {
      this.polling = false;
    }
  }
}
