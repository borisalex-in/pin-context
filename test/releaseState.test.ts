import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateDocsVersionLabel, updateReadmeVersionBadge } from '../scripts/versionMetadata';
import { isPreparedReleaseSnapshot } from '../scripts/releaseState';

const previousVersion = '0.0.6';
const preparedVersion = '0.0.7';

function packageJson(version: string): string {
  return `${JSON.stringify({ name: 'pin-context', version, description: 'unchanged' }, null, 2)}\n`;
}

function readme(version: string): string {
  return `# Pin Context\n\n[![Version](https://img.shields.io/badge/version-${version}-blue.svg)](https://example.com)\n`;
}

function docsIndex(version: string): string {
  return `<div class="hero-meta" aria-label="Extension details">\n  <span>v${version}</span>\n  <span>VS Code ≥ 1.102</span>\n</div>\n`;
}

function lockfile(version: string): string {
  return `${JSON.stringify(
    {
      name: 'pin-context',
      version,
      packages: { '': { name: 'pin-context', version } }
    },
    null,
    2
  )}\n`;
}

function preparedSnapshot() {
  return {
    bump: 'patch' as const,
    committedPackageJson: packageJson(previousVersion),
    workingPackageJson: packageJson(preparedVersion),
    committedReadme: readme(previousVersion),
    workingReadme: updateReadmeVersionBadge(readme(previousVersion), preparedVersion),
    committedDocsIndex: docsIndex(previousVersion),
    workingDocsIndex: updateDocsVersionLabel(docsIndex(previousVersion), preparedVersion),
    committedPackageLock: lockfile(previousVersion),
    workingPackageLock: lockfile(preparedVersion)
  };
}

test('release:ship recognizes the exact version-only state left by release:patch', () => {
  assert.equal(isPreparedReleaseSnapshot(preparedSnapshot()), true);
});

test('release:ship does not resume if source metadata contains unrelated edits', () => {
  const snapshot = preparedSnapshot();
  snapshot.workingDocsIndex += '<!-- unrelated edit -->\n';
  assert.equal(isPreparedReleaseSnapshot(snapshot), false);
});

test('release:ship does not resume if package fields changed beyond version', () => {
  const snapshot = preparedSnapshot();
  const workingPackage = JSON.parse(snapshot.workingPackageJson) as Record<string, unknown>;
  workingPackage.description = 'unexpected change';
  snapshot.workingPackageJson = `${JSON.stringify(workingPackage, null, 2)}\n`;
  assert.equal(isPreparedReleaseSnapshot(snapshot), false);
});

test('release scripts expose ship and push as separate operations', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')
  ) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    pkg.scripts['release:ship'],
    'npm run precommit:check && tsx scripts/release.ts patch --commit --tag'
  );
  assert.equal(pkg.scripts['release:push'], 'npx tsx scripts/release.ts --push --tag');
});
