import { readdir, rm } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Remove configuration files left by extension-host processes that no longer exist.
 * Only files following our PID-bearing fallback name are considered; workspace-scoped
 * `agent-bridge.json` is intentionally left to the current workspace instance.
 */
export async function cleanupStaleBridgeConfigs(
  directory: string,
  currentPid = process.pid,
  isProcessRunning: (pid: number) => boolean = processIsRunning
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const removed: string[] = [];
  for (const entry of entries) {
    const match = /^agent-bridge-(\d+)\.json$/.exec(entry);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === currentPid || isProcessRunning(pid))
      continue;

    try {
      await rm(path.join(directory, entry), { force: true });
      removed.push(entry);
    } catch {
      // Stale-file cleanup is best effort and must not prevent activation.
    }
  }
  return removed;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
