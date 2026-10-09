import * as vscode from 'vscode';
import { logger } from '../utils/logger';

/**
 * Structural types for the built-in `vscode.git` extension API, mirroring
 * `extensions/git/src/api/git.d.ts` from the VS Code repository. Declared locally on
 * purpose: `@types/git-vscod` must not become a new dependency of this extension.
 */

const GIT_EXTENSION_ID = 'vscode.git';

// Numeric members of the `Status` const enum in git.d.ts.
const STATUS_UNTRACKED = 7;
const STATUS_IGNORED = 8;
// `RefType.Head`; the enum is `const`, so it does not exist at runtime.
const REF_TYPE_HEAD = 0;

interface GitApiDisposable {
  dispose(): void;
}

type GitApiListener = (arg?: unknown) => void;
type GitApiEvent = (listener: GitApiListener) => GitApiDisposable;

interface GitApiChange {
  // Upstream exposes the numeric `Status` enum; some builds use the porcelain letter instead.
  status?: number;
  type?: string;
}

interface GitApiRef {
  type?: number;
  name?: string;
  commit?: string;
}

interface GitApiRepositoryState {
  HEAD?: GitApiRef;
  refs?: GitApiRef[];
  indexChanges?: GitApiChange[];
  workingTreeChanges?: GitApiChange[];
  // Upstream name; `onDidChangeState` exists only in some distributions.
  onDidChange?: GitApiEvent;
  onDidChangeState?: GitApiEvent;
}

interface GitApiRepository {
  rootUri: { scheme?: string; fsPath?: string };
  state?: GitApiRepositoryState;
}

interface GitApi {
  repositories?: GitApiRepository[];
  onDidChangeState?: GitApiEvent;
  onDidOpenRepository?: GitApiEvent;
  onDidCloseRepository?: GitApiEvent;
  // Not part of the upstream API; honoured when a distribution offers one aggregate event.
  onDidChangeRepositories?: GitApiEvent;
}

interface GitApiExtensionExports {
  enabled?: boolean;
  getAPI?: (version: number) => GitApi;
  RepositoryRefType?: { Head?: number };
  RefType?: { Head?: number };
}

export interface GitApiSnapshot {
  branch: string;
  staged: number;
  changed: number;
}

/** Normalizes a path so folder/repo-root prefixes can be compared across platforms. */
export function normalizeGitPath(value: string): string {
  const slashes = value.replace(/\\/g, '/');
  return slashes.length > 1 ? slashes.replace(/\/+$/, '') : slashes;
}

// The CLI path counts tracked changes only (`git status -uno`), so untracked/ignored
// entries must not inflate the API-derived counters either.
function isUntrackedOrIgnored(change: GitApiChange | undefined): boolean {
  if (!change) {
    return true;
  }
  if (typeof change.status === 'number') {
    return change.status === STATUS_UNTRACKED || change.status === STATUS_IGNORED;
  }
  return change.type === '?' || change.type === '!';
}

function countTrackedChanges(changes: GitApiChange[] | undefined): number {
  if (!Array.isArray(changes)) {
    return 0;
  }
  return changes.filter((change) => !isUntrackedOrIgnored(change)).length;
}

function looksLikeLocalBranch(name: string): boolean {
  return !/(^|\/)remotes\//.test(name) && !/(^|\/)tags\//.test(name);
}

function shortBranchName(name: string): string {
  return name.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : name;
}

function branchNameFromHead(head: GitApiRef | undefined): string | undefined {
  if (!head) {
    return undefined;
  }
  const name = head.name?.trim();
  if (name) {
    return name;
  }
  // Detached HEAD has no name; mirror the CLI fallback `detached@<short sha>`.
  const commit = head.commit?.trim();
  return commit ? `detached@${commit.slice(0, 7)}` : 'detached';
}

/**
 * Reads branch and change counters from the `vscode.git` extension instead of spawning
 * `git status`. Emits `onDidChange` whenever the API reports any repository change so
 * the consumer can re-read snapshots and diff them against its own state.
 */
export class GitApiSource {
  private api: GitApi | undefined;
  private headRefType = REF_TYPE_HEAD;
  private disposed = false;

  private readonly apiSubscriptions: GitApiDisposable[] = [];
  // Keyed by normalized root path: the API returns fresh wrapper objects on every
  // `repositories` access, so subscriptions are tracked per repository, not per object.
  private readonly repoSubscriptions = new Map<string, GitApiDisposable>();

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  /**
   * Activates `vscode.git` and subscribes to its events.
   * Resolves to false when the extension is missing, disabled or does not expose the
   * expected API — the caller must then fall back to running the git CLI.
   */
  async tryInitialize(): Promise<boolean> {
    try {
      const extension = vscode.extensions.getExtension(GIT_EXTENSION_ID);
      if (!extension) {
        logger.debug('vscode.git extension is not available; using the git CLI fallback.');
        return false;
      }

      const exports = (await extension.activate()) as GitApiExtensionExports | undefined;
      if (this.disposed || !exports) {
        return false;
      }
      if (exports.enabled === false) {
        logger.debug('vscode.git is disabled; using the git CLI fallback.');
        return false;
      }
      if (typeof exports.getAPI !== 'function') {
        logger.debug('vscode.git does not expose getAPI(); using the git CLI fallback.');
        return false;
      }

      const api = exports.getAPI(1);
      if (!api || !Array.isArray(api.repositories)) {
        logger.debug('vscode.git API has no repositories; using the git CLI fallback.');
        return false;
      }

      const headType = exports.RepositoryRefType?.Head ?? exports.RefType?.Head;
      if (typeof headType === 'number') {
        this.headRefType = headType;
      }

      this.api = api;
      this.subscribeApi(api);
      this.syncRepositories();
      logger.debug('Git contexts are driven by the vscode.git extension API.');
      return true;
    } catch (error) {
      logger.debug(`Failed to initialize the vscode.git API: ${String(error)}`);
      this.disposeSubscriptions();
      this.api = undefined;
      return false;
    }
  }

  /** Live snapshot for a workspace folder, or undefined when no API repository covers it. */
  getSnapshot(folderPath: string): GitApiSnapshot | undefined {
    const state = this.findRepository(folderPath)?.state;
    if (!state) {
      return undefined;
    }
    const branch = branchNameFromHead(state.HEAD);
    if (!branch) {
      return undefined;
    }
    return {
      branch,
      staged: countTrackedChanges(state.indexChanges),
      changed: countTrackedChanges(state.workingTreeChanges)
    };
  }

  /**
   * Local branch names, or undefined when the API cannot answer (no repository or the
   * deprecated `refs` list is empty in newer builds) — the caller falls back to the CLI.
   */
  getLocalBranches(folderPath: string): string[] | undefined {
    const refs = this.findRepository(folderPath)?.state?.refs;
    if (!Array.isArray(refs) || refs.length === 0) {
      return undefined;
    }

    const names: string[] = [];
    for (const ref of refs) {
      const name = ref?.name?.trim();
      if (!name) {
        continue;
      }
      // Prefer the numeric ref type; only fall back to name heuristics when it is absent.
      const isHead =
        typeof ref.type === 'number' ? ref.type === this.headRefType : looksLikeLocalBranch(name);
      if (isHead) {
        names.push(shortBranchName(name));
      }
    }
    return names;
  }

  dispose(): void {
    this.disposed = true;
    this.disposeSubscriptions();
    this.changeEmitter.dispose();
  }

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------

  private subscribeApi(api: GitApi): void {
    const fire = () => this.changeEmitter.fire();
    const resyncAndFire = () => {
      this.syncRepositories();
      this.changeEmitter.fire();
    };
    this.addSubscription(api, api.onDidChangeState, fire, this.apiSubscriptions);
    this.addSubscription(api, api.onDidOpenRepository, resyncAndFire, this.apiSubscriptions);
    this.addSubscription(api, api.onDidCloseRepository, resyncAndFire, this.apiSubscriptions);
    this.addSubscription(api, api.onDidChangeRepositories, resyncAndFire, this.apiSubscriptions);
  }

  /**
   * Re-reads the repository list: subscribes to newly opened repositories and releases
   * closed ones. Existing repositories keep their subscription even though the API
   * returns new wrapper objects each time.
   */
  private syncRepositories(): void {
    const repositories = this.api?.repositories;
    if (!Array.isArray(repositories)) {
      return;
    }

    const active = new Set<string>();
    for (const repository of repositories) {
      const key = this.repositoryKey(repository);
      if (!key || active.has(key) || this.repoSubscriptions.has(key)) {
        active.add(key ?? '');
        continue;
      }
      active.add(key);

      const state = repository.state;
      const event = state?.onDidChange ?? state?.onDidChangeState;
      const noop = new vscode.Disposable(() => {});
      if (typeof event !== 'function') {
        // Record the repository anyway: re-subscribing on every resync would leak.
        this.repoSubscriptions.set(key, noop);
        continue;
      }
      try {
        this.repoSubscriptions.set(
          key,
          event.call(state, () => this.changeEmitter.fire())
        );
      } catch (error) {
        logger.debug(`Failed to subscribe to a vscode.git repository state: ${String(error)}`);
        this.repoSubscriptions.set(key, noop);
      }
    }

    for (const [key, subscription] of [...this.repoSubscriptions]) {
      if (!active.has(key)) {
        this.repoSubscriptions.delete(key);
        this.disposeQuietly(subscription);
      }
    }
  }

  private addSubscription(
    owner: object,
    event: GitApiEvent | undefined,
    handler: GitApiListener,
    store: GitApiDisposable[]
  ): void {
    if (typeof event !== 'function') {
      return;
    }
    try {
      const subscription = event.call(owner, handler);
      if (subscription && typeof subscription.dispose === 'function') {
        store.push(subscription);
      }
    } catch (error) {
      logger.debug(`Failed to subscribe to a vscode.git API event: ${String(error)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Repository lookup
  // ---------------------------------------------------------------------------

  private repositoryKey(repository: GitApiRepository | undefined): string | undefined {
    const rootUri = repository?.rootUri;
    if (!rootUri || typeof rootUri.fsPath !== 'string') {
      return undefined;
    }
    // Non-file (virtual) repositories are out of scope, same as for workspace folders.
    if (rootUri.scheme && rootUri.scheme !== 'file') {
      return undefined;
    }
    return normalizeGitPath(rootUri.fsPath);
  }

  /**
   * Mirrors the CLI semantics (`git status` with cwd = folder): the repository either is
   * the folder itself or one of its ancestors. Repositories nested *inside* a workspace
   * folder were never picked up by the CLI, so they are not picked up here either.
   */
  private findRepository(folderPath: string): GitApiRepository | undefined {
    const repositories = this.api?.repositories;
    if (!Array.isArray(repositories)) {
      return undefined;
    }

    const folder = normalizeGitPath(folderPath);
    let best: GitApiRepository | undefined;
    let bestLength = -1;

    for (const repository of repositories) {
      const root = this.repositoryKey(repository);
      if (!root) {
        continue;
      }
      if (root === folder) {
        return repository;
      }
      if (folder.startsWith(`${root}/`) && root.length > bestLength) {
        best = repository;
        bestLength = root.length;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  private disposeSubscriptions(): void {
    for (const subscription of this.apiSubscriptions.splice(0)) {
      this.disposeQuietly(subscription);
    }
    for (const [, subscription] of this.repoSubscriptions) {
      this.disposeQuietly(subscription);
    }
    this.repoSubscriptions.clear();
  }

  private disposeQuietly(subscription: GitApiDisposable): void {
    try {
      subscription.dispose();
    } catch (error) {
      logger.debug(`Failed to dispose a vscode.git subscription: ${String(error)}`);
    }
  }
}
