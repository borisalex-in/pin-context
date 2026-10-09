import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const mockPath = require.resolve('./vscodeMock');
const originalResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') return mockPath;
  return originalResolve.call(this, request, ...rest);
};

const { createExtensionContext, testHarness } = require('./vscodeMock');
const { ContextPersistenceService } = require('../src/services/contextPersistenceService');
const SNAPSHOT_KEY = 'pin-context.contexts.snapshot';
const LAST_SCOPE_KEY = 'pin-context.contexts.persistenceScope.last';

after(() => {
  (Module as any)._resolveFilename = originalResolve;
});

const snapshot = (name: string) => ({
  contexts: [
    {
      id: `manual:${name}`,
      name,
      source: 'manual',
      pinnedUris: [],
      createdAt: 1,
      updatedAt: 1
    }
  ],
  timeline: []
});

test('migrates a legacy fallback snapshot into the selected persistence scope', async () => {
  testHarness.reset();
  testHarness.settings['contexts.persistenceScope'] = 'globalState';
  const context = createExtensionContext();
  context.workspaceState.store.set(SNAPSHOT_KEY, snapshot('legacy-workspace'));

  const service = new ContextPersistenceService(context);
  const loaded = await service.load();

  assert.equal(loaded?.contexts[0].name, 'legacy-workspace');
  assert.equal(context.globalState.store.get(SNAPSHOT_KEY).contexts[0].name, 'legacy-workspace');
  assert.equal(context.workspaceState.store.has(SNAPSHOT_KEY), false);
  assert.equal(context.workspaceState.store.get(LAST_SCOPE_KEY), 'globalState');
});

test('a live persistence-scope change migrates the current snapshot and avoids stale resurrection', async () => {
  testHarness.reset();
  testHarness.settings['contexts.persistenceScope'] = 'workspaceState';
  const context = createExtensionContext();
  context.workspaceState.store.set(SNAPSHOT_KEY, snapshot('initial'));
  const service = new ContextPersistenceService(context);

  assert.equal((await service.load())?.contexts[0].name, 'initial');
  testHarness.settings['contexts.persistenceScope'] = 'globalState';
  assert.equal(await service.save(snapshot('latest')), true);
  assert.equal(context.globalState.store.get(SNAPSHOT_KEY).contexts[0].name, 'latest');
  assert.equal(context.workspaceState.store.has(SNAPSHOT_KEY), false);
  assert.equal(context.workspaceState.store.get(LAST_SCOPE_KEY), 'globalState');

  testHarness.settings['contexts.persistenceScope'] = 'workspaceState';
  const migratedBack = await service.load();
  assert.equal(migratedBack?.contexts[0].name, 'latest');
  assert.equal(context.workspaceState.store.get(SNAPSHOT_KEY).contexts[0].name, 'latest');
  // Switching to workspaceState keeps the shared global snapshot for other workspaces.
  assert.equal(context.globalState.store.get(SNAPSHOT_KEY).contexts[0].name, 'latest');
});

test('save reports persistence failures instead of returning success', async () => {
  testHarness.reset();
  const context = createExtensionContext();
  context.workspaceState.update = async () => {
    throw new Error('write denied');
  };
  const service = new ContextPersistenceService(context);
  assert.equal(await service.save(snapshot('unsaved')), false);
  assert.ok(testHarness.messages.some((message: string) => message.startsWith('error:')));
});
