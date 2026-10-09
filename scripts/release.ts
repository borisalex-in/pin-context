// Release orchestrator: bump -> build -> optional commit/tag/push/publish.
// Git mutations and marketplace publish run only behind explicit flags, so a
// real release never happens by accident. See RELEASE.md for the full cycle.
//
// Usage:
//   npx tsx scripts/release.ts <patch|minor|major> [flags]   bump + build (+ actions)
//   npx tsx scripts/release.ts --commit --tag                actions on the current version
//   npx tsx scripts/release.ts --status
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

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
  --commit          git add package.json README.md && git commit -m "release: v<version>"
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

// Local preview of the next version; only used for --dry-run output,
// the real bump is always done by `npm version` itself.
function nextVersion(version: string, bump: BumpType): string {
  const [major, minor, patch] = version.split('-')[0].split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// Runs git inside the repo and captures its output; returns null on failure.
function gitCapture(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
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
  return dirty ? `dirty (${dirty.split('\n').length} file(s))` : 'clean';
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
    run('git', ['add', 'package.json', 'README.md'], opts);
    run('git', ['commit', '-m', message], opts);
  }
  if (opts.tag) {
    run('git', ['tag', `v${current}`], opts);
  }
  if (opts.push) {
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

const expectedNext = nextVersion(current, opts.bump);
console.log(`[release] current version: ${current}, next (${opts.bump}): ${expectedNext}`);

// Guard: a release must be reproducible, so require a clean tree.
if (gitCapture(['rev-parse', '--is-inside-work-tree']) !== 'true') {
  fail('not inside a git working tree, cannot release');
}
const dirty = gitCapture(['status', '--porcelain']) ?? '';
if (dirty && !opts.allowDirty) {
  console.error(dirty);
  fail('working tree is not clean — commit/stash changes or re-run with --allow-dirty');
}

if (opts.dryRun) {
  console.log('[dry-run] nothing will be changed');
}

// Bump only package.json/lockfile; the `version` lifecycle script syncs the
// README badge. Git stays untouched — commit/tag are explicit flags below.
run(npmBin, ['version', opts.bump, '--no-git-tag-version', '--no-commit-hooks'], opts);
const newVersion = opts.dryRun ? expectedNext : readVersion();

// Build after the bump so the artifact carries the new version.
run(npmBin, ['run', 'build:vsix'], opts);

const message = opts.message ?? `release: v${newVersion}`;
if (opts.commit) {
  run('git', ['add', 'package.json', 'README.md'], opts);
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
if (actionFlags.length > 0) {
  console.log('[release] next step (run it explicitly when ready):');
  console.log(`  $ npx tsx scripts/release.ts ${actionFlags.join(' ')}`);
}
