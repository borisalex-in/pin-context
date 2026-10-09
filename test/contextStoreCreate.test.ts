import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const mockPath = require.resolve('./vscodeMock');
const originalResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') return mockPath;
  return originalResolve.call(this, request, ...rest);
};

const { createExtensionContext, testHarness, EventEmitter } = require('./vscodeMock');
const { ContextStore } = require('../src/stores/contextStore');

after(() => {
  (Module as any)._resolveFilename = originalResolve;
});

test('failed persistence does not report an unsaved context as created', async () => {
  testHarness.reset();
  const extensionContext = createExtensionContext();
  extensionContext.workspaceState.update = async (key: string, value: unknown) => {
    if (key === 'pin-context.contexts.snapshot') throw new Error('simulated storage failure');
    if (value === undefined) extensionContext.workspaceState.store.delete(key);
    else extensionContext.workspaceState.store.set(key, value);
  };
  const event = new EventEmitter().event;
  const pinStore = { onDidChange: event, getPinnedUris: () => [] };
  const gitContextService = { onDidChangeBranch: event, onDidChangeStatus: event };
  const store = new ContextStore(extensionContext, pinStore as any, gitContextService as any);

  const created = await store.createManualContext('Unsaved context');
  assert.equal(created, undefined);
  assert.equal(
    store.getAllContexts().some((context: { name: string }) => context.name === 'Unsaved context'),
    false
  );
  assert.ok(testHarness.messages.some((message: string) => message.startsWith('error:')));

  store.dispose();
});
