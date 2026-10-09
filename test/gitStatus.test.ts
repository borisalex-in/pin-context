import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGitStatus } from '../src/utils/gitStatus';

test('parses branch with upstream and counts', () => {
  const out = '## main...origin/main [ahead 1]\n M a.ts\nM  b.ts\nMM c.ts\n';
  assert.deepEqual(parseGitStatus(out), { branch: 'main', detached: false, staged: 2, changed: 2 });
});

test('branch name that contains slashes', () => {
  assert.equal(parseGitStatus('## feature/foo-bar\n').branch, 'feature/foo-bar');
});

test('detached HEAD', () => {
  const parsed = parseGitStatus('## HEAD (no branch)\n M a.ts\n');
  assert.equal(parsed.detached, true);
  assert.equal(parsed.branch, undefined);
  assert.equal(parsed.changed, 1);
});

test('unborn branch', () => {
  assert.equal(parseGitStatus('## No commits yet on main\n').branch, 'main');
  assert.equal(parseGitStatus('## Initial commit on dev\n').branch, 'dev');
});

test('untracked and ignored files are not counted', () => {
  const parsed = parseGitStatus('## main\n?? new.ts\n!! ignored.log\n');
  assert.equal(parsed.staged, 0);
  assert.equal(parsed.changed, 0);
});

test('staged, unstaged, and mixed statuses have explicit counter semantics', () => {
  const parsed = parseGitStatus(
    '## main\nM  staged.ts\n M working.ts\nMM mixed.ts\nAM added-then-edited.ts\nR  old.ts -> new.ts\nC  copy.ts\n'
  );
  assert.equal(parsed.staged, 5, 'X-column changes, including rename/copy, count as staged');
  assert.equal(parsed.changed, 3, 'Y-column changes count as working-tree changes');
});

test('unmerged states remain visible as changes but are not counted as staged', () => {
  const parsed = parseGitStatus(
    '## main\nUU conflict.ts\nAU added-conflict.ts\nUD deleted-conflict.ts\n'
  );
  assert.equal(parsed.staged, 1, 'only the A in AU is a staged addition');
  assert.equal(parsed.changed, 3, 'all unmerged entries remain visible as changes');
});

test('CRLF output', () => {
  const parsed = parseGitStatus('## main\r\n M a.ts\r\n');
  assert.equal(parsed.branch, 'main');
  assert.equal(parsed.changed, 1);
});
