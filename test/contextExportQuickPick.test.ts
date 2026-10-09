import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const mockPath = require.resolve('./vscodeMock');
const originalResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') return mockPath;
  return originalResolve.call(this, request, ...rest);
};

const mock = require('./vscodeMock');
const { testHarness, Uri } = mock;
const { showExportContextsQuickPick } = require('../src/ui/contextQuickPick');

after(() => {
  (Module as any)._resolveFilename = originalResolve;
});

test('export dialog starts in the workspace and duplicate names remain individually selectable', async () => {
  testHarness.reset();
  const contexts = [
    { id: 'manual:one', name: 'Same name', pinnedUris: ['file:///ws/a.ts'] },
    { id: 'manual:two', name: 'Same name', pinnedUris: ['file:///ws/b.ts'] }
  ];
  let selected: typeof contexts = [];
  let saveOptions: any;
  const originalSaveDialog = mock.window.showSaveDialog;
  mock.window.showSaveDialog = async (options: unknown) => {
    saveOptions = options;
    return Uri.file('/ws/export.json');
  };
  testHarness.quickPickAnswers.push((items: any[]) => [items[1]]);
  const store = {
    getExportableContexts: () => contexts,
    exportContexts: async (_uri: unknown, chosen: typeof contexts) => {
      selected = chosen;
      return true;
    }
  };

  try {
    await showExportContextsQuickPick(store as any);
  } finally {
    mock.window.showSaveDialog = originalSaveDialog;
  }

  assert.equal(saveOptions.defaultUri.path, '/ws/pin-contexts-pin-context.json');
  assert.deepEqual(
    selected.map((context) => context.id),
    ['manual:two']
  );
});
