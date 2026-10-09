import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const mockPath = require.resolve('./vscodeMock');
const originalResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') return mockPath;
  return originalResolve.call(this, request, ...rest);
};

const { createExtensionContext, testHarness, Uri, EventEmitter } = require('./vscodeMock');
const { ContextStore } = require('../src/stores/contextStore');

after(() => {
  (Module as any)._resolveFilename = originalResolve;
});

function createStore(context: ReturnType<typeof createExtensionContext>) {
  const event = new EventEmitter().event;
  const pinStore = { onDidChange: event };
  const gitService = { onDidChangeBranch: event, onDidChangeStatus: event };
  return new ContextStore(context, pinStore as any, gitService as any);
}

test('imported contexts use the same id as their map key and can be looked up later', async () => {
  testHarness.reset();
  const extensionContext = createExtensionContext();
  testHarness.readableFiles.set(
    '/ws/import.json',
    JSON.stringify({ version: 1, contexts: [{ name: 'Imported', paths: ['src/a.ts'] }] })
  );
  const store = createStore(extensionContext);

  const result = await store.importContexts(Uri.file('/ws/import.json'));
  assert.deepEqual(
    { added: result.added, updated: result.updated, saved: result.saved },
    {
      added: 1,
      updated: 0,
      saved: true
    }
  );
  const [mapKey, imported] = [...(store as any).contexts.entries()][0];
  assert.equal(mapKey, imported.id);
  assert.equal(store.getContextById(imported.id)?.name, 'Imported');
  assert.equal(
    extensionContext.workspaceState.store.get('pin-context.contexts.snapshot').contexts[0].id,
    imported.id
  );

  store.dispose();
});

test('failed import persistence rolls back the in-memory import', async () => {
  testHarness.reset();
  const extensionContext = createExtensionContext();
  testHarness.readableFiles.set(
    '/ws/import.json',
    JSON.stringify({ version: 1, contexts: [{ name: 'Unsaved', paths: ['src/a.ts'] }] })
  );
  extensionContext.workspaceState.update = async (key: string, value: unknown) => {
    if (key === 'pin-context.contexts.snapshot') throw new Error('simulated storage failure');
    if (value === undefined) extensionContext.workspaceState.store.delete(key);
    else extensionContext.workspaceState.store.set(key, value);
  };
  const store = createStore(extensionContext);

  const result = await store.importContexts(Uri.file('/ws/import.json'));
  assert.deepEqual(
    { added: result.added, updated: result.updated, saved: result.saved },
    {
      added: 0,
      updated: 0,
      saved: false
    }
  );
  assert.equal(store.getAllContexts().length, 0);

  store.dispose();
});

test('failed stale-context cleanup restores the in-memory contexts', async () => {
  testHarness.reset();
  const extensionContext = createExtensionContext();
  extensionContext.workspaceState.update = async (key: string, value: unknown) => {
    if (key === 'pin-context.contexts.snapshot') throw new Error('simulated storage failure');
    if (value === undefined) extensionContext.workspaceState.store.delete(key);
    else extensionContext.workspaceState.store.set(key, value);
  };
  const store = createStore(extensionContext);
  const stale = {
    id: 'git:/ws:deleted-branch',
    name: 'deleted-branch',
    source: 'git',
    workspaceFolder: '/ws',
    branch: 'deleted-branch',
    pinnedUris: ['file:///ws/src/a.ts'],
    createdAt: 1,
    updatedAt: 1
  };
  (store as any).contexts.set(stale.id, stale);
  (store as any).staleContextIds.add(stale.id);

  const removed = await store.removeStaleContexts();
  assert.equal(removed, 0);
  assert.equal(store.getContextById(stale.id)?.name, 'deleted-branch');
  assert.deepEqual(
    store.getStaleContexts().map((context: { id: string }) => context.id),
    [stale.id]
  );

  store.dispose();
});
