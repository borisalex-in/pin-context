// Cross-platform clean: removes out/ and root-level *.vsix build artifacts.
// Usage: tsx scripts/clean.ts [--dry-run]
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');
const targets: string[] = [];

const outDir = path.join(root, 'out');
if (existsSync(outDir)) {
  targets.push(outDir);
}

for (const name of readdirSync(root)) {
  if (name.endsWith('.vsix')) {
    targets.push(path.join(root, name));
  }
}

if (targets.length === 0) {
  console.log('[clean] nothing to remove');
  process.exit(0);
}

for (const target of targets) {
  const label = path.relative(root, target);
  if (dryRun) {
    console.log(`[clean] (dry-run) would remove ${label}`);
    continue;
  }
  rmSync(target, { recursive: true, force: true });
  console.log(`[clean] removed ${label}`);
}

console.log(`[clean] ${dryRun ? 'targets to remove' : 'targets removed'}: ${targets.length}`);
