import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

// Route `require('vscode')` to the in-memory mock before the service is loaded.
const mockPath = require.resolve('./vscodeMock');
const originalResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') return mockPath;
  return originalResolve.call(this, request, ...rest);
};

const mock = require('./vscodeMock');
const { testHarness, Uri } = mock;
const { GitContextService } = require('../src/services/gitContextService');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A path that does not exist on disk: were the service ever to fall back to the git CLI,
// the spawn would fail with ENOENT instead of running a process, so any data returned
// here can only come from the fake vscode.git API.
const ROOT = '/pin-context-fake-repo';

// Values mirror the real git API: RefType.Head = 0, RemoteHead = 1, Tag = 2.
const REF_TYPE_HEAD = 0;
const REF_TYPE_REMOTE_HEAD = 1;
const REF_TYPE_TAG = 2;

const services: any[] = [];
after(() => services.forEach((service) => service.dispose()));

function installFakeGitApi(options: {
  head: { name?: string; commit?: string };
  indexChanges: unknown[];
  workingTreeChanges: unknown[];
  refs?: unknown[];
}) {
  const stateChanged = new mock.EventEmitter();
  const repository = {
    rootUri: Uri.file(ROOT),
    state: {
      HEAD: options.head,
      refs: options.refs ?? [],
      indexChanges: options.indexChanges,
      workingTreeChanges: options.workingTreeChanges,
      onDidChange: stateChanged.event
    }
  };
  testHarness.gitApi = {
    repositories: [repository],
    onDidChangeState: new mock.EventEmitter().event,
    onDidOpenRepository: new mock.EventEmitter().event,
    onDidCloseRepository: new mock.EventEmitter().event
  };
  return { repository, stateChanged };
}

async function createService(): Promise<any> {
  testHarness.workspaceRoot = ROOT;
  mock.window.state.focused = true;
  const service = new GitContextService();
  services.push(service);
  // Let the fake extension.activate() promise settle so the API source is installed.
  await sleep(0);
  return service;
}

test('git info comes from the vscode.git API without spawning git', async () => {
  installFakeGitApi({
    head: { name: 'feature/x', commit: '0123456789abcdef0123456789abcdef01234567' },
    indexChanges: [{}, {}],
    // One entry is untracked (`type: '?'`, the CLI path counts with -uno) -> ignored.
    workingTreeChanges: [{}, {}, { type: '?' }]
  });

  const service = await createService();
  const contexts = await service.getCurrentWorkspaceGitContexts();

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].workspaceFolder, ROOT);
  assert.equal(contexts[0].branch, 'feature/x');
  assert.equal(contexts[0].staged, 2);
  assert.equal(contexts[0].changed, 2);
});

test('onDidChangeBranch fires from state.onDidChange without polling', async () => {
  const { repository, stateChanged } = installFakeGitApi({
    head: { name: 'feature/x', commit: '0123456789abcdef0123456789abcdef01234567' },
    indexChanges: [],
    workingTreeChanges: []
  });

  const service = await createService();
  await service.getCurrentWorkspaceGitContexts(); // seeds the known branch

  const branchChanges: any[] = [];
  service.onDidChangeBranch((event: any) => branchChanges.push(event));

  repository.state.HEAD.name = 'feature/y';
  stateChanged.fire();
  await sleep(0);

  assert.deepEqual(branchChanges, [
    { workspaceFolder: ROOT, oldBranch: 'feature/x', newBranch: 'feature/y' }
  ]);
});

test('getLocalBranches filters refs by type, falling back to name heuristics', async () => {
  installFakeGitApi({
    head: { name: 'main', commit: '0123456789abcdef0123456789abcdef01234567' },
    indexChanges: [],
    workingTreeChanges: [],
    refs: [
      { type: REF_TYPE_HEAD, name: 'main', commit: 'a' },
      { type: REF_TYPE_HEAD, name: 'feature/x', commit: 'b' },
      { type: REF_TYPE_REMOTE_HEAD, name: 'origin/main', commit: 'c' },
      { type: REF_TYPE_TAG, name: 'v1.0', commit: 'd' },
      { name: 'remotes/origin/stale' }, // untyped remote branch -> excluded by name
      { name: 'tags/legacy' }, // untyped tag -> excluded by name
      { name: 'trunk' } // untyped local branch -> kept
    ]
  });

  const service = await createService();

  assert.deepEqual(await service.getLocalBranches(ROOT), ['main', 'feature/x', 'trunk']);
  // Paths outside the trusted file-scheme workspace folders must never reach the CLI.
  assert.deepEqual(await service.getLocalBranches('/somewhere-else'), []);
});
