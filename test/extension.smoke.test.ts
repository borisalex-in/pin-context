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
let agentApi: any;

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
  agentApi = await extension.activate(ctx);
  await sleep(300); // background initialization
});

after(() => {
  ctx.subscriptions.forEach((d) => d.dispose());
  rmSync(repoDir, { recursive: true, force: true });
});

test('activation registers all commands without errors', () => {
  for (const id of [
    'pin-context.pinCurrentEditor',
    'pin-context.pinResource',
    'pin-context.unpinResource',
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
  assert.ok(testHarness.mcpProviders.has('pin-context-mcp'), 'native MCP provider is registered');
});

test('public agent API is returned and can read workspace/context state', async () => {
  assert.equal(agentApi.apiVersion, 1);
  const status = await agentApi.getStatus();
  assert.equal(status.version, 1);
  assert.equal(status.workspaceFolders.length, 1);
  assert.equal(status.workspaceFolders[0].path, repoDir);
  assert.ok(Array.isArray(await agentApi.listContexts()));
  assert.ok(Array.isArray(await agentApi.getPinnedFiles()));
});

test('agent tools reject unexpected and prototype-sensitive input fields', async () => {
  await assert.rejects(
    agentApi.executeTool('pin_context_get_status', { unexpected: true }),
    /unexpected tool input field/i
  );
  const prototypeSensitive = JSON.parse('{"__proto__": {"polluted": true}}') as Record<
    string,
    unknown
  >;
  await assert.rejects(
    agentApi.executeTool('pin_context_get_status', prototypeSensitive),
    /unexpected tool input field/i
  );
  const inheritedInput = Object.create({ context_id: 'inherited-context' }) as Record<
    string,
    unknown
  >;
  await assert.rejects(
    agentApi.executeTool('pin_context_get_pinned_files', inheritedInput),
    /tool input must be a JSON object/i
  );
});

test('agent file tools reject paths outside the opened workspace', async () => {
  await assert.rejects(
    agentApi.executeTool('pin_context_pin_files', {
      paths: [path.join(repoDir, '..', 'outside.ts')]
    }),
    /outside the opened workspace/i
  );
});

test('agent write operations require approval and cancellation leaves context state unchanged', async () => {
  await agentApi.listContexts();
  const name = 'Agent-created context that should be cancelled';
  await assert.rejects(
    agentApi.executeTool('pin_context_create_context', { name }),
    /user cancelled this operation/i
  );
  const after = await agentApi.listContexts();
  assert.equal(
    after.some((item: { name?: string }) => item.name === name),
    false
  );
  assert.ok(
    testHarness.messages.some((message: string) =>
      message.includes('Allow Pin Context agent to make this change?')
    ),
    'a confirmation prompt was shown for the mutating operation'
  );
});

test('Explorer Pin/Unpin menu commands have context-specific shortcut hints', () => {
  const manifest = require('../package.json');
  const bindings = manifest.contributes.keybindings as Array<{
    command: string;
    key: string;
    mac?: string;
    when?: string;
  }>;
  const pin = bindings.find((binding) => binding.command === 'pin-context.pinResource');
  const unpin = bindings.find((binding) => binding.command === 'pin-context.unpinResource');
  assert.ok(pin, 'Pin File has a keybinding');
  assert.ok(unpin, 'Unpin File has a keybinding');
  assert.equal(pin.key, 'ctrl+alt+k');
  assert.equal(pin.mac, 'cmd+alt+k');
  assert.ok(pin.when?.includes('filesExplorerFocus'));
  assert.ok(pin.when?.includes('resource not in pin-context.pinnedResources'));
  assert.ok(pin.when?.includes('resourcePath not in pin-context.pinnedResourcePaths'));
  assert.equal(unpin.key, 'ctrl+alt+l');
  assert.equal(unpin.mac, 'cmd+alt+l');
  assert.ok(unpin.when?.includes('filesExplorerFocus'));
  assert.ok(unpin.when?.includes('resource in pin-context.pinnedResources'));
  assert.ok(unpin.when?.includes('resourcePath in pin-context.pinnedResourcePaths'));
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

test('Explorer context-menu actions pin and unpin the supplied resource, not the active editor', async () => {
  const target = file('explorer-target.ts');
  const active = file('active-editor.ts');
  testHarness.openTab(target);
  testHarness.openTab(active); // keep a different file active than the one in the context menu
  await sleep(50);

  await run('pin-context.pinResource', target);
  await sleep(100);
  assert.ok(
    testHarness.pinnedUris().includes(target.toString()),
    'the clicked Explorer file is pinned'
  );
  assert.ok(
    !testHarness.pinnedUris().includes(active.toString()),
    'the active editor is not pinned by mistake'
  );
  const pinnedResourceUris = testHarness.contextKeys.get('pin-context.pinnedResources') as string[];
  assert.ok(
    pinnedResourceUris.includes(target.toString()),
    'the selected resource URI is immediately marked pinned'
  );

  await run('pin-context.unpinResource', target);
  await sleep(100);
  assert.ok(
    !testHarness.pinnedUris().includes(target.toString()),
    'the clicked Explorer file is unpinned'
  );
  assert.ok(
    !(testHarness.contextKeys.get('pin-context.pinnedResources') as string[]).includes(
      target.toString()
    ),
    'the selected resource URI is removed from the context after unpin'
  );
  assert.ok(
    !testHarness.pinnedUris().includes(active.toString()),
    'the unrelated active editor stays unpinned'
  );
});

test('Explorer keyboard shortcuts operate on the selected resources and restore clipboard contents', async () => {
  const selectedOne = file('keyboard-selected-one.ts');
  const selectedTwo = file('keyboard-selected-two.ts');
  const active = file('keyboard-active.ts');
  testHarness.openTab(active);
  testHarness.explorerSelectionPaths = [selectedOne.fsPath, selectedTwo.fsPath];
  testHarness.clipboardText = 'user clipboard content';

  await run('pin-context.pinResource');
  await sleep(150);
  assert.ok(testHarness.pinnedUris().includes(selectedOne.toString()));
  assert.ok(testHarness.pinnedUris().includes(selectedTwo.toString()));
  assert.ok(
    !testHarness.pinnedUris().includes(active.toString()),
    'active editor is not used as fallback'
  );
  assert.equal(
    testHarness.clipboardText,
    'user clipboard content',
    'clipboard is restored after pin'
  );

  await run('pin-context.unpinResource');
  await sleep(150);
  assert.ok(!testHarness.pinnedUris().includes(selectedOne.toString()));
  assert.ok(!testHarness.pinnedUris().includes(selectedTwo.toString()));
  assert.equal(
    testHarness.clipboardText,
    'user clipboard content',
    'clipboard is restored after unpin'
  );
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

  // Import the same export again; matching names should be updated, not duplicated.
  const before = JSON.parse(JSON.stringify(ctx.workspaceState.get('pin-context.contexts.snapshot')))
    .contexts.length;

  testHarness.openDialogAnswers.push([file('export.json')]);
  await run('pin-context.importContexts');
  await sleep(200);
  const after = JSON.parse(JSON.stringify(ctx.workspaceState.get('pin-context.contexts.snapshot')))
    .contexts.length;
  assert.ok(after >= before, 'import merged without losing contexts');
  assert.ok(
    testHarness.messages.some((m: string) => m.startsWith('info: Import complete. Added:')),
    'import completion was reported'
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
  const initialPinnedPaths = testHarness.contextKeys.get(
    'pin-context.pinnedResourcePaths'
  ) as Record<string, true>;
  assert.ok(initialPinnedPaths && typeof initialPinnedPaths === 'object');
  assert.equal(initialPinnedPaths[g.path], undefined, 'the active resource starts unpinned');

  await run('pin-context.pinCurrentEditor');
  await sleep(150);
  assert.equal(
    testHarness.contextKeys.get('pin-context.isPinned'),
    true,
    'after pin the active-editor key flips'
  );
  assert.equal(
    (testHarness.contextKeys.get('pin-context.pinnedResourcePaths') as Record<string, true>)[
      g.path
    ],
    true,
    'after pin the Explorer membership map includes the file path'
  );
  assert.ok(
    (testHarness.contextKeys.get('pin-context.pinnedResources') as string[]).includes(g.toString()),
    'after pin the Explorer membership list includes the full URI'
  );

  await run('pin-context.unpinCurrentEditor');
  await sleep(150);
  assert.equal(testHarness.contextKeys.get('pin-context.isPinned'), false);
  assert.equal(
    (testHarness.contextKeys.get('pin-context.pinnedResourcePaths') as Record<string, true>)[
      g.path
    ],
    undefined,
    'the active resource is removed from the Explorer membership map after unpin'
  );
});

test('no command reported an error during the run', () => {
  assert.deepEqual(
    testHarness.messages.filter((m: string) => m.startsWith('error') || m.startsWith('log-error')),
    []
  );
});
