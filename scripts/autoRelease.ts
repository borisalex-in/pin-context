import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { nextReleaseVersion, type ReleaseBump } from './releaseState';

const root = path.resolve(__dirname, '..');
const allowedBumps = new Set<ReleaseBump>(['patch', 'minor', 'major']);

function fail(message: string): never {
  console.error(`[auto-release] ERROR: ${message}`);
  process.exit(1);
}

function run(command: string, args: string[], capture = false): string {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    }).trim();
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    fail(`command failed: ${command} ${args.join(' ')}\n${details}`);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`missing required environment variable ${name}`);
  return value;
}

const bump = requiredEnv('RELEASE_BUMP') as ReleaseBump;
if (!allowedBumps.has(bump)) fail(`unsupported release bump: ${bump}`);
const prNumber = requiredEnv('RELEASE_PR_NUMBER');
const prTitle = requiredEnv('RELEASE_PR_TITLE').replace(/\s+/g, ' ').trim();
const prUrl = requiredEnv('RELEASE_PR_URL');
if (!/^\d+$/.test(prNumber)) fail(`invalid PR number: ${prNumber}`);
if (!/^https:\/\//.test(prUrl)) fail('RELEASE_PR_URL must be an https URL');
if (!prTitle) fail('PR title must not be empty');

const status = run('git', ['status', '--porcelain', '--untracked-files=all'], true);
if (status) fail(`working tree must be clean before preparing a release:\n${status}`);
if (run('git', ['branch', '--show-current'], true) !== 'main') {
  fail('auto-release must run from the main branch');
}

const changelogPath = path.join(root, 'CHANGELOG.md');
const existingChangelog = readFileSync(changelogPath, 'utf8');
const packageJsonPath = path.join(root, 'package.json');
const currentPackage = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string };
const currentVersion = currentPackage.version;

// Allow a failed workflow to be rerun after the atomic push succeeded but a later
// GitHub Release or Marketplace step failed. Rebuild the exact tagged version only.
if (existingChangelog.includes(prUrl)) {
  const existingTag = `v${currentVersion}`;
  if (run('git', ['tag', '--list', existingTag], true) !== existingTag) {
    fail(`PR #${prNumber} is already in CHANGELOG.md, but tag ${existingTag} is missing`);
  }
  run('npm', ['run', 'build:vsix']);
  console.log(`[auto-release] resuming publication of ${existingTag} for PR #${prNumber}`);
  process.exit(0);
}

const newVersion = nextReleaseVersion(currentVersion, bump);
const tag = `v${newVersion}`;
if (run('git', ['tag', '--list', tag], true) === tag) fail(`tag ${tag} already exists`);

// npm's version lifecycle synchronizes package.json, README.md, and docs/index.html.
run('npm', ['version', bump, '--no-git-tag-version', '--no-commit-hooks']);
const actualVersion = (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string }).version;
if (actualVersion !== newVersion) {
  fail(`expected version ${newVersion} after bump, got ${actualVersion}`);
}

const unreleasedHeading = /^## \[Unreleased\]\s*$/m;
const match = unreleasedHeading.exec(existingChangelog);
if (!match) fail('CHANGELOG.md must contain a ## [Unreleased] section');
const bodyStart = match.index + match[0].length;
const nextRelease = /^## \[[^\]]+\]/m.exec(existingChangelog.slice(bodyStart));
const bodyEnd = nextRelease ? bodyStart + nextRelease.index : existingChangelog.length;
const unreleasedBody = existingChangelog.slice(bodyStart, bodyEnd).trim();
const date = new Date().toISOString().slice(0, 10);
const prEntry = `### Merged pull requests\n\n- ${prTitle} ([#${prNumber}](${prUrl}))`;
const releaseBody = [unreleasedBody, prEntry].filter(Boolean).join('\n\n');
const newChangelog = [
  existingChangelog.slice(0, bodyStart).trimEnd(),
  '',
  `## [${newVersion}] - ${date}`,
  '',
  releaseBody,
  '',
  existingChangelog.slice(bodyEnd).trimStart()
].join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
writeFileSync(changelogPath, newChangelog, 'utf8');

// Build before creating the commit/tag so a packaging failure cannot publish a broken release.
run('npm', ['run', 'build:vsix']);

run('git', ['config', 'user.name', 'github-actions[bot]']);
run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
const files = ['package.json', 'README.md', 'docs/index.html', 'CHANGELOG.md'];
const trackedLock = run('git', ['ls-files', '--error-unmatch', 'package-lock.json'], true) === 'package-lock.json';
if (trackedLock) files.push('package-lock.json');
run('git', ['add', ...files]);
run('git', ['commit', '-m', `chore(release): v${newVersion}`]);
run('git', ['tag', '-a', tag, '-m', `Release ${tag}`]);

// Push the branch update and tag atomically: neither should reach origin alone.
run('git', ['push', '--atomic', 'origin', 'HEAD:main', `refs/tags/${tag}`]);
console.log(`[auto-release] published release commit and ${tag} for PR #${prNumber}`);
