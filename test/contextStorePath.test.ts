import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';

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

test('repository context save does not match a sibling workspace sharing the same path prefix', async () => {
  testHarness.reset();
  const context = createExtensionContext();
  const event = new EventEmitter().event;
  const store = new ContextStore(
    context,
    { onDidChange: event } as any,
    { onDidChangeBranch: event, onDidChangeStatus: event } as any
  );

  const root = path.parse(process.cwd()).root;
  const targetWorkspace = path.join(root, 'work', 'app');
  const siblingFile = Uri.file(
    path.join(root, 'work', 'application', '.vscode', 'pin-contexts.json')
  );
  let wroteFile = false;
  (store as any).fileService.repoFileUris = () => [siblingFile];
  (store as any).fileService.write = async () => {
    wroteFile = true;
    return true;
  };

  const result = await (store as any).writeRepoContextFile({
    id: 'repo:test',
    name: 'test',
    source: 'repo',
    workspaceFolder: targetWorkspace,
    pinnedUris: []
  });

  assert.equal(result, false);
  assert.equal(wroteFile, false);
  store.dispose();
});
