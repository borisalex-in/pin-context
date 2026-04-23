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

export class GitContextService {
  private cache = new Map<string, CachedGitContextInfo>();
  private readonly ttlMs = 3000;

  async getCurrentWorkspaceGitContexts(): Promise<GitContextInfo[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const results = await Promise.allSettled(
      folders.map((folder) => this.getGitInfoForFolder(folder.uri.fsPath))
    );
    return results
      .filter(
        (result): result is PromiseFulfilledResult<GitContextInfo> => result.status === 'fulfilled'
      )
      .map((result) => result.value);
  }

  private async getGitInfoForFolder(folderPath: string): Promise<GitContextInfo> {
    const cached = this.cache.get(folderPath);
    if (cached && Date.now() - cached.createdAt < this.ttlMs) {
      return cached.value;
    }

    const branch = (await this.execGit(['rev-parse', '--abbrev-ref', 'HEAD'], folderPath)).trim();
    const status = await this.execGit(['status', '--porcelain'], folderPath);
    const lines = status.split('\n').filter(Boolean);
    const staged = lines.filter((line) => line[0] !== ' ').length;
    const changed = lines.filter((line) => line[1] !== ' ').length;

    const value: GitContextInfo = {
      workspaceFolder: folderPath,
      branch,
      staged,
      changed
    };
    this.cache.set(folderPath, { value, createdAt: Date.now() });
    return value;
  }

  private async execGit(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout;
  }
}
