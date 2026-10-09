import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const mockPath = require.resolve('./vscodeMock');
const originalResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') return mockPath;
  return originalResolve.call(this, request, ...rest);
};

const { Uri, testHarness } = require('./vscodeMock');
const { parseContexts } = require('../src/services/contextFileService');

after(() => {
  (Module as any)._resolveFilename = originalResolve;
});

test('import parser ignores malformed path fields without aborting the whole file', () => {
  testHarness.reset();
  const parsed = parseContexts(
    JSON.stringify({
      version: 1,
      contexts: [
        {
          name: 'valid',
          paths: [
            'src/a.ts',
            '../outside.ts',
            {},
            'command:workbench.action.closeAllEditors',
            'file:///outside/file.ts'
          ]
        },
        { name: 'bad-object', paths: {}, pinnedUris: [] },
        { name: 'bad-string', paths: [], pinnedUris: 'src/b.ts' },
        null,
        { name: 'unknown-scheme', paths: ['javascript:alert(1)'] }
      ]
    }),
    Uri.file('/ws')
  );

  assert.deepEqual(
    parsed.map((context: { name: string }) => context.name),
    ['valid', 'unknown-scheme']
  );
  assert.deepEqual(parsed[0].pinnedUris, ['file:///ws/src/a.ts', 'file:///outside/file.ts']);
  assert.deepEqual(parsed[1].pinnedUris, []);
});

test('invalid JSON and missing contexts array are treated as empty imports', () => {
  testHarness.reset();
  assert.deepEqual(parseContexts('{oops', Uri.file('/ws')), []);
  assert.deepEqual(parseContexts(JSON.stringify({ contexts: {} }), Uri.file('/ws')), []);
});
