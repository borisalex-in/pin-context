import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { cleanupStaleBridgeConfigs } from '../src/agent/bridgeCleanup';

test('bridge cleanup removes only stale PID-named configs and preserves live/current files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pin-context-bridge-cleanup-'));
  try {
    for (const name of [
      'agent-bridge-111.json',
      'agent-bridge-222.json',
      'agent-bridge-333.json',
      'agent-bridge.json',
      'unrelated.json'
    ]) {
      await writeFile(path.join(directory, name), name, 'utf8');
    }

    const removed = await cleanupStaleBridgeConfigs(directory, 222, (pid) => pid === 333);
    assert.deepEqual(removed, ['agent-bridge-111.json']);
    const remaining = (await readdir(directory)).sort();
    assert.deepEqual(remaining, [
      'agent-bridge-222.json',
      'agent-bridge-333.json',
      'agent-bridge.json',
      'unrelated.json'
    ]);
    assert.equal(
      await readFile(path.join(directory, 'agent-bridge-333.json'), 'utf8'),
      'agent-bridge-333.json'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bridge cleanup is harmless when the global storage directory does not exist', async () => {
  const directory = path.join(os.tmpdir(), `pin-context-missing-bridge-dir-${process.pid}`);
  await rm(directory, { recursive: true, force: true });
  assert.deepEqual(await cleanupStaleBridgeConfigs(directory, process.pid, () => false), []);
});
