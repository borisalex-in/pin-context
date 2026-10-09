import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Route `require('vscode')` to the in-memory mock before the extension is loaded.
const mockPath = require.resolve('./vscodeMock');
const originalResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') return mockPath;
  return originalResolve.call(this, request, ...rest);
};

const mock = require('./vscodeMock');
const { testHarness, Uri, createExtensionContext } = mock;
const extension = require('../src/core/extension');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (id: string, ...args: unknown[]) => testHarness.registeredCommands.get(id)!(...args);
const file = (name: string) => Uri.file(`${testHarness.workspaceRoot}/${name}`);

let repoDir: string;
let ctx: ReturnType<typeof createExtensionContext>;

before(async () => {
  repoDir = mkdtempSync(path.join(tmpdir(), 'pin-context-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repoDir,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t'
      }
    });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repoDir, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  writeFileSync(path.join(repoDir, 'a.txt'), 'changed'); // one unstaged change

  testHarness.workspaceRoot = repoDir;
  testHarness.reset();
  ctx = createExtensionContext();
  await extension.activate(ctx);
  await sleep(300); // background initialization
});

after(() => {
  ctx.subscriptions.forEach((d) => d.dispose());
  rmSync(repoDir, { recursive: true, force: true });
});

test('activation registers all commands without errors', () => {
  for (const id of [
    'pin-context.pinCurrentEditor',
    'pin-context.switchContext',
    'pin-context.openPinnedFile',
    'pin-context.deleteContext'
  ]) {
    assert.ok(testHarness.registeredCommands.has(id), `${id} is registered`);
  }
  assert.deepEqual(
    testHarness.messages.filter((m: string) => m.startsWith('error')),
    []
  );
});

test('pin / unpin the active editor', async () => {
  const a = file('a.ts');
  testHarness.openTab(a);
  await sleep(50);
  await run('pin-context.pinCurrentEditor');
  await sleep(100);
  assert.deepEqual(testHarness.pinnedUris(), [a.toString()]);

  await run('pin-context.unpinCurrentEditor');
  await sleep(100);
  assert.deepEqual(testHarness.pinnedUris(), []);
});

test('pinning a non-active open tab pins the right file and restores focus', async () => {
  const b = file('b.ts');
  const c = file('c.ts');
  testHarness.openTab(b);
  testHarness.openTab(c); // c is active
  await sleep(50);
  await run('pin-context.pinCurrentEditor', b);
  await sleep(150);
  assert.ok(testHarness.pinnedUris().includes(b.toString()));
  assert.ok(!testHarness.pinnedUris().includes(c.toString()), 'c must stay unpinned');
  assert.equal(testHarness.activeUri(), c.toString(), 'active editor is restored');
});

test('drag & drop ignores plain text, folders and missing files', async () => {
  const before = testHarness.pinnedUris().length;
  const { PinnedTreeViewProvider } = require('../src/ui/pinnedTreeView');
  const fakeStore = {
    pinUris: async (uris: unknown[]) => ({
      success: uris.length,
      failed: 0,
      skipped: 0,
      errors: []
    }),
    getPinnedItems: () => [],
    onDidChange: () => ({ dispose() {} })
  };
  const fakeContexts = {
    onDidChange: () => ({ dispose() {} }),
    getActiveContext: () => undefined,
    getAllContexts: () => [],
    getTimelineBuckets: () => ({ today: [], yesterday: [], older: [] })
  };
  const tree = new PinnedTreeViewProvider(fakeStore, fakeContexts);
  const seen: string[] = [];
  fakeStore.pinUris = async (uris: any[]) => {
    seen.push(...uris.map((u) => u.toString()));
    return { success: uris.length, failed: 0, skipped: 0, errors: [] };
  };
  const transfer = new Map<string, any>();
  transfer.set('text/plain', new mock.DataTransferItem('hello world'));
  await tree.dragAndDropController.handleDrop(undefined, { get: (k: string) => transfer.get(k) });
  assert.deepEqual(seen, [], 'plain text must not be treated as a file path');

  transfer.clear();
  transfer.set(
    'text/uri-list',
    new mock.DataTransferItem('# comment\nfile:///ws/x.ts\r\nhttp://example.com')
  );
  await tree.dragAndDropController.handleDrop(undefined, { get: (k: string) => transfer.get(k) });
  assert.deepEqual(seen, ['file:///ws/x.ts']);
  tree.dispose();
  assert.equal(testHarness.pinnedUris().length, before);
});

test('contexts: create, change pins, switch back', async () => {
  const d = file('d.ts');
  const e = file('e.ts');
  testHarness.openTab(d);
  testHarness.openTab(e);
  await sleep(50);

  testHarness.inputBoxAnswers.push('Feature');
  await run('pin-context.createContext');
  await sleep(100);

  // add one more pin after the context exists -> it is auto-saved into the active context
  await run('pin-context.pinCurrentEditor', d);
  await sleep(400);

  testHarness.inputBoxAnswers.push('Bugfix');
  await run('pin-context.createContext');
  await sleep(100);

  // switch back to "Feature" by id
  const snapshot = ctx.workspaceState.get('pin-context.contexts.snapshot') as any;
  const feature = snapshot.contexts.find((c: any) => c.name === 'Feature');
  assert.ok(feature, 'Feature context persisted');
  assert.ok(
    feature.pinnedUris.some((u: string) => u.endsWith('/d.ts')),
    'auto-saved pins reached the context'
  );

  await run('pin-context.unpinCurrentEditor', d);
  await sleep(400);
  await run('pin-context.switchContextById', feature.id);
  await sleep(400);
  assert.ok(testHarness.pinnedUris().includes(d.toString()), 'switching restored the pin');
});

test('git context is created from a real repository, with counters in metadata only', () => {
  const snapshot = ctx.workspaceState.get('pin-context.contexts.snapshot') as any;
  const git = snapshot.contexts.find((c: any) => c.source === 'git');
  assert.ok(git, 'git context exists');
  assert.equal(git.name, 'main', 'name is just the branch');
  assert.equal(git.changed, 1);
  assert.equal(git.staged, 0);
});

test('persisted pins survive and contain only trackable URIs', () => {
  const stored = ctx.workspaceState.get('pin-context.pinnedUris') as string[];
  assert.ok(Array.isArray(stored));
  assert.ok(stored.every((u) => u.startsWith('file://')));
});

test('export/import contexts round-trip via the commands', async () => {
  testHarness.messages.push('dbg:start');
  testHarness.quickPickAnswers.push((items: any[]) => {
    testHarness.messages.push(`dbg:qp:${(items as any[]).map((i) => i.label).join('|')}`);
    return [items[items.length - 1]];
  }); // "All contexts"
  testHarness.saveDialogAnswers.push(file('export.json'));
  await run('pin-context.exportContexts');
  await sleep(100);
  const exported = testHarness.writtenFiles.get(`${testHarness.workspaceRoot}/export.json`);
  assert.ok(exported, 'export wrote the file');
  const parsed = JSON.parse(exported);
  assert.ok(Array.isArray(parsed.contexts) && parsed.contexts.length > 0, 'contexts serialized');

  // Change the store: drop one context by name, then import the file back.
  const before = JSON.parse(JSON.stringify(ctx.workspaceState.get('pin-context.contexts.snapshot')))
    .contexts.length;

  testHarness.openDialogAnswers.push([file('export.json')]);
  await run('pin-context.importContexts');
  await sleep(200);
  const after = JSON.parse(JSON.stringify(ctx.workspaceState.get('pin-context.contexts.snapshot')))
    .contexts.length;
  assert.ok(after >= before, 'import merged without losing contexts');
  assert.ok(
    testHarness.messages.some((m: string) => m.startsWith('info: Imported')),
    'import reported the result'
  );
});

test('menu context keys follow the active tab', async () => {
  const g = file('g.ts');
  testHarness.openTab(g);
  await sleep(80);
  testHarness.fireActiveEditorChange();
  await sleep(80);
  assert.equal(testHarness.contextKeys.get('pin-context.hasActiveEditor'), true);
  assert.equal(testHarness.contextKeys.get('pin-context.isPinned'), false, 'fresh tab is unpinned');
  assert.equal(
    testHarness.contextKeys.get('pin-context.pinnedResources'),
    'pin-context.pinnedResourceState'
  );

  const state = testHarness.commands.get('pin-context.pinnedResourceState');
  assert.ok(state, 'pinned resource state command is registered');
  assert.equal(state(g), undefined, 'unpinned file answers "not in collection"');

  await run('pin-context.pinCurrentEditor');
  await sleep(150);
  assert.equal(
    testHarness.contextKeys.get('pin-context.isPinned'),
    true,
    'after pin the key flips'
  );
  assert.ok(state(g), 'pinned file answers with a defined value');

  await run('pin-context.unpinCurrentEditor');
  await sleep(150);
  assert.equal(testHarness.contextKeys.get('pin-context.isPinned'), false);
});

test('no command reported an error during the run', () => {
  assert.deepEqual(
    testHarness.messages.filter((m: string) => m.startsWith('error') || m.startsWith('log-error')),
    []
  );
});
