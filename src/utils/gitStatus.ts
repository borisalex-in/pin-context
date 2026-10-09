export interface ParsedGitStatus {
  branch: string | undefined;
  detached: boolean;
  staged: number;
  changed: number;
}

/**
 * Parses the output of `git status --porcelain=v1 --branch -uno`.
 * Pure function (no vscode dependency) so it can be unit-tested.
 */
export function parseGitStatus(output: string): ParsedGitStatus {
  const result: ParsedGitStatus = { branch: undefined, detached: false, staged: 0, changed: 0 };
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    if (!line) {
      continue;
    }

    if (line.startsWith('## ')) {
      const header = line.slice(3);

      if (header.startsWith('HEAD (no branch)')) {
        result.detached = true;
        continue;
      }

      const unborn = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(header);
      if (unborn) {
        result.branch = unborn[1].trim();
        continue;
      }

      const upstreamIndex = header.indexOf('...');
      result.branch =
        upstreamIndex >= 0 ? header.slice(0, upstreamIndex) : header.replace(/ \[.*\]$/, '');
      continue;
    }

    if (line.length < 3) {
      continue;
    }

    const x = line[0];
    const y = line[1];
    if ((x === '?' && y === '?') || (x === '!' && y === '!')) {
      continue;
    }
    // `U` means an unresolved merge conflict, not a staged change. Keep it visible as
    // a working-tree change but do not mislabel it as staged.
    if (x !== ' ' && x !== 'U') {
      result.staged += 1;
    }
    if (y !== ' ') {
      result.changed += 1;
    }
  }

  return result;
}
