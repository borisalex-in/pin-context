// Release orchestrator: bump -> build -> optional commit/tag/push/publish.
// Git mutations and marketplace publish run only behind explicit flags, so a
// real release never happens by accident. See RELEASE.md for the full cycle.
//
// Usage:
//   npx tsx scripts/release.ts <patch|minor|major> [flags]   bump + build (+ actions)
//   npx tsx scripts/release.ts --commit --tag                actions on the current version
//   npx tsx scripts/release.ts --status
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isPreparedReleaseSnapshot, nextReleaseVersion } from './releaseState';

const root = path.resolve(__dirname, '..');
// npm/npx are .cmd shims on Windows; execFileSync needs the suffix there.
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const BUMPS = ['patch', 'minor', 'major'] as const;
type BumpType = (typeof BUMPS)[number];

interface ReleaseOptions {
  bump: BumpType | null;
  status: boolean;
  dryRun: boolean;
  allowDirty: boolean;
  commit: boolean;
  tag: boolean;
  push: boolean;
  publish: boolean;
  message: string | null;
}

const USAGE = `Usage:
  npx tsx scripts/release.ts <patch|minor|major> [flags]   bump, build and (by flags) release
  npx tsx scripts/release.ts --commit --tag [--push]        apply actions to the current version
  npx tsx scripts/release.ts --status

Flags:
  --dry-run         print every command as "[dry-run] ..." and change nothing
  --allow-dirty     allow a dirty git working tree when bumping
  --commit          stage release metadata (and tracked package-lock.json), then commit
  --tag             git tag v<version>
  --push            git push (plus "git push origin v<version>" together with --tag)
  --publish         npx @vscode/vsce publish --no-dependencies
  --message <text>  commit message instead of "release: v<version>" (use with --commit)
`;

function fail(message: string): never {
  console.error(`[release] ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): ReleaseOptions {
  const opts: ReleaseOptions = {
    bump: null,
    status: false,
    dryRun: false,
    allowDirty: false,
    commit: false,
    tag: false,
    push: false,
    publish: false,
    message: null
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--status':
        opts.status = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--allow-dirty':
        opts.allowDirty = true;
        break;
      case '--commit':
        opts.commit = true;
        break;
      case '--tag':
        opts.tag = true;
        break;
      case '--push':
        opts.push = true;
        break;
      case '--publish':
        opts.publish = true;
        break;
      case '--message':
        {
          const message = argv[++i];
          if (!message || message.startsWith('--')) {
            fail('--message requires a text argument');
          }
          opts.message = message;
        }
        break;
      default:
        if ((BUMPS as readonly string[]).includes(arg)) {
          if (opts.bump) fail(`bump type specified twice: ${opts.bump} and ${arg}`);
          opts.bump = arg as BumpType;
        } else {
          console.error(USAGE);
          fail(`unknown argument: ${arg}`);
        }
    }
  }
  const hasActions = opts.commit || opts.tag || opts.push || opts.publish;
  if (!opts.status && !opts.bump && !hasActions) {
    console.error(USAGE);
    fail('a bump type (patch|minor|major), an action flag or --status is required');
  }
  if (opts.message && !opts.commit) {
    console.log('[release] NOTE: --message has no effect without --commit');
  }
  return opts;
}

function readVersion(): string {
  const pkgPath = path.join(root, 'package.json');
  let raw: string;
  try {
    raw = readFileSync(pkgPath, 'utf8');
  } catch {
    fail(`cannot read ${pkgPath}`);
  }
  const version = (JSON.parse(raw) as { version?: unknown }).version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
    fail(`package.json has no valid semver "version" field (got ${JSON.stringify(version)})`);
  }
  return version;
}

// Local preview used for dry-run output and prepared-release detection.
const nextVersion = nextReleaseVersion;

// Runs git inside the repo and captures its output; returns null on failure.
function gitCapture(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return null;
  }
}

function gitReadFile(relativePath: string): string | null {
  try {
    return execFileSync('git', ['show', `HEAD:${relativePath}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    return null;
  }
}

interface GitStatusEntry {
  code: string;
  path: string;
}

function getGitStatusEntries(): GitStatusEntry[] | null {
  try {
    // Do not trim leading spaces: the first two characters encode Git's status.
    const output = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trimEnd();
    if (!output) return [];
    return output.split(/\r?\n/).map((line) => {
      const code = line.slice(0, 2);
      const rawPath = line.slice(3);
      const pathParts = rawPath.split(' -> ');
      const pathName = pathParts.length > 1 ? pathParts[pathParts.length - 1] : rawPath;
      return { code, path: pathName.replace(/^"|"$/g, '') };
    });
  } catch {
    return null;
  }
}

function canResumePreparedRelease(bump: BumpType, currentVersion: string): boolean {
  const entries = getGitStatusEntries();
  if (!entries || entries.length === 0) return false;

  const allowedPaths = new Set([
    'package.json',
    'README.md',
    'docs/index.html',
    'package-lock.json'
  ]);
  for (const entry of entries) {
    if (allowedPaths.has(entry.path)) continue;
    // Some repos do not ignore generated VSIX files. Permit only this release's artifact.
    if (entry.code === '??' && entry.path === `pin-context-${currentVersion}.vsix`) continue;
    return false;
  }

  for (const requiredPath of ['package.json', 'README.md', 'docs/index.html']) {
    if (!entries.some((entry) => entry.path === requiredPath)) return false;
  }

  const committedPackageJson = gitReadFile('package.json');
  const committedReadme = gitReadFile('README.md');
  const committedDocsIndex = gitReadFile('docs/index.html');
  if (!committedPackageJson || !committedReadme || !committedDocsIndex) return false;

  const lockIsTracked = gitCapture(['ls-files', '--error-unmatch', 'package-lock.json']) !== null;
  if (!lockIsTracked && entries.some((entry) => entry.path === 'package-lock.json')) return false;
  let committedPackageLock: string | undefined;
  let workingPackageLock: string | undefined;
  if (lockIsTracked) {
    committedPackageLock = gitReadFile('package-lock.json') ?? undefined;
    const lockPath = path.join(root, 'package-lock.json');
    if (!committedPackageLock || !existsSync(lockPath)) return false;
    workingPackageLock = readFileSync(lockPath, 'utf8');
  }

  const snapshotMatches = isPreparedReleaseSnapshot({
    bump,
    committedPackageJson,
    workingPackageJson: readFileSync(path.join(root, 'package.json'), 'utf8'),
    committedReadme,
    workingReadme: readFileSync(path.join(root, 'README.md'), 'utf8'),
    committedDocsIndex,
    workingDocsIndex: readFileSync(path.join(root, 'docs', 'index.html'), 'utf8'),
    committedPackageLock,
    workingPackageLock
  });

  if (!snapshotMatches) return false;
  if (gitCapture(['tag', '--list', `v${currentVersion}`]) === `v${currentVersion}`) {
    fail(`tag v${currentVersion} already exists; refusing to create a duplicate release`);
  }
  return true;
}

function releaseFilesToStage(): string[] {
  const files = ['package.json', 'README.md', 'docs/index.html'];
  // Stage the lockfile when this repository tracks it; never add an ignored/untracked lock by accident.
  if (gitCapture(['ls-files', '--error-unmatch', 'package-lock.json']) === 'package-lock.json') {
    files.push('package-lock.json');
  }
  return files;
}

// Runs a command with inherited stdio; --dry-run only prints it.
function run(cmd: string, args: string[], { dryRun }: Pick<ReleaseOptions, 'dryRun'>): void {
  const printable = [cmd, ...args].join(' ');
  if (dryRun) {
    console.log(`[dry-run] ${printable}`);
    return;
  }
  console.log(`[release] $ ${printable}`);
  try {
    execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });
  } catch {
    fail(`command failed: ${printable}`);
  }
}

function describeTree(): string {
  if (gitCapture(['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return 'not a git repository';
  }
  const dirty = gitCapture(['status', '--porcelain']);
  if (dirty === null) return 'unknown (git failed)';
  return dirty ? `dirty (changed paths: ${dirty.split('\n').length})` : 'clean';
}

function printStatus(): void {
  console.log('[release] status');
  console.log(`  version in package.json: ${readVersion()}`);
  const vsix = readdirSync(root).filter((name) => name.endsWith('.vsix'));
  console.log(`  .vsix in repo root:      ${vsix.length ? vsix.join(', ') : 'none'}`);
  console.log(`  git working tree:        ${describeTree()}`);
  const tags = (gitCapture(['tag', '--sort=-v:refname']) || '')
    .split('\n')
    .filter(Boolean)
    .slice(0, 5);
  console.log(`  latest tags:             ${tags.length ? tags.join(', ') : 'none'}`);
}

const opts = parseArgs(process.argv.slice(2));

if (opts.status) {
  printStatus();
  process.exit(0);
}

const current = readVersion();

// Without a bump type the script only applies the requested actions to the version that
// is in package.json right now. That is how commit/tag/push/publish stay separate,
// explicit steps after a `release:patch` (which already bumped and built).
if (!opts.bump) {
  const message = opts.message ?? `release: v${current}`;
  if (opts.commit) {
    run('git', ['add', ...releaseFilesToStage()], opts);
    run('git', ['commit', '-m', message], opts);
  }
  if (opts.tag) {
    const tagExists = gitCapture(['tag', '--list', `v${current}`]) === `v${current}`;
    if (opts.push && !tagExists) {
      fail(`tag v${current} does not exist locally; run release:ship before release:push`);
    }
    if (!opts.push) {
      if (tagExists) {
        fail(`tag v${current} already exists; refusing to create a duplicate release`);
      }
      run('git', ['tag', `v${current}`], opts);
    }
  }
  if (opts.push) {
    if (opts.tag && gitCapture(['tag', '--list', `v${current}`]) !== `v${current}`) {
      fail(`tag v${current} does not exist locally; run release:ship before release:push`);
    }
    const pushStatus = getGitStatusEntries();
    if (pushStatus === null) fail('could not inspect the git working tree before push');
    if (pushStatus.length > 0) {
      console.error(pushStatus.map((entry) => `${entry.code} ${entry.path}`).join('\n'));
      fail('working tree is not clean; commit or stash unrelated changes before release:push');
    }
    run('git', ['push'], opts);
    if (opts.tag) {
      run('git', ['push', 'origin', `v${current}`], opts);
    }
  }
  if (opts.publish) {
    run(npxBin, ['@vscode/vsce', 'publish', '--no-dependencies'], opts);
  }
  console.log(`[release] done: v${current}${opts.dryRun ? ' (dry-run, nothing was changed)' : ''}`);
  process.exit(0);
}

if (gitCapture(['rev-parse', '--is-inside-work-tree']) !== 'true') {
  fail('not inside a git working tree, cannot release');
}

const expectedNext = nextVersion(current, opts.bump);
const preparedRelease = opts.commit && opts.tag && canResumePreparedRelease(opts.bump, current);
const statusEntries = getGitStatusEntries();
if (statusEntries === null) fail('could not inspect the git working tree');
const dirty = statusEntries.length > 0;

if (dirty && !opts.allowDirty && !preparedRelease) {
  console.error(statusEntries.map((entry) => `${entry.code} ${entry.path}`).join('\n'));
  fail(
    'working tree is not clean — commit/stash source changes first. If release:patch already bumped the version, release:ship can finalize it only when the remaining diff contains version metadata.'
  );
}

let newVersion: string;
if (preparedRelease) {
  newVersion = current;
  console.log(
    `[release] detected a prepared ${newVersion} version from release:patch; will finalize it without bumping again`
  );
} else {
  console.log(`[release] current version: ${current}, next (${opts.bump}): ${expectedNext}`);
  if (opts.dryRun) console.log('[dry-run] nothing will be changed');

  // Bump package.json/lockfile; the `version` lifecycle syncs README and docs/index.html.
  run(npmBin, ['version', opts.bump, '--no-git-tag-version', '--no-commit-hooks'], opts);
  newVersion = opts.dryRun ? expectedNext : readVersion();
}

// Always rebuild after the final version is known, including the resume-after-patch flow.
run(npmBin, ['run', 'build:vsix'], opts);

if (
  opts.tag &&
  !opts.dryRun &&
  gitCapture(['tag', '--list', `v${newVersion}`]) === `v${newVersion}`
) {
  fail(`tag v${newVersion} already exists; refusing to create a duplicate release`);
}

const message = opts.message ?? `release: v${newVersion}`;
if (opts.commit) {
  run('git', ['add', ...releaseFilesToStage()], opts);
  run('git', ['commit', '-m', message], opts);
}
if (opts.tag) {
  run('git', ['tag', `v${newVersion}`], opts);
}
if (opts.push) {
  run('git', ['push'], opts);
  if (opts.tag) {
    run('git', ['push', 'origin', `v${newVersion}`], opts);
  }
}
if (opts.publish) {
  run(npxBin, ['@vscode/vsce', 'publish', '--no-dependencies'], opts);
}

const actionFlags = [
  opts.commit ? null : '--commit',
  opts.tag ? null : '--tag',
  opts.push ? null : '--push',
  opts.publish ? null : '--publish'
].filter(Boolean);

console.log(
  `[release] done: v${newVersion}${opts.dryRun ? ' (dry-run, nothing was changed)' : ' built'}`
);
if (opts.dryRun) {
  if (actionFlags.length > 0) {
    console.log('[release] next step (after reviewing the dry run):');
    console.log(`  $ npx tsx scripts/release.ts ${actionFlags.join(' ')}`);
  }
} else if (!opts.commit && !opts.tag) {
  console.log('[release] next step (when ready to finalize this version):');
  console.log('  $ npm run release:ship');
} else if (opts.commit && opts.tag && !opts.push) {
  console.log('[release] next step (after reviewing the release commit and tag):');
  console.log('  $ npm run release:push');
}
