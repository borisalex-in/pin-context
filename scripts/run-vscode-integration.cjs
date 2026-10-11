const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let runTests;
try {
  ({ runTests } = require('@vscode/test-electron'));
} catch {
  console.error(
    'Missing optional integration-test runner. Run `npm run test:integration:install` first.'
  );
  process.exit(1);
}

const root = path.resolve(__dirname, '..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-context-vscode-workspace-'));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-context-vscode-user-data-'));
const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-context-vscode-extensions-'));

function git(...args) {
  execFileSync('git', args, {
    cwd: workspace,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Pin Context Integration Test',
      GIT_AUTHOR_EMAIL: 'pin-context-test@example.invalid',
      GIT_COMMITTER_NAME: 'Pin Context Integration Test',
      GIT_COMMITTER_EMAIL: 'pin-context-test@example.invalid'
    }
  });
}

async function main() {
  fs.writeFileSync(path.join(workspace, 'fixture.ts'), 'export const fixture = true;\n', 'utf8');
  git('init', '-b', 'main');
  git('config', 'user.name', 'Pin Context Integration Test');
  git('config', 'user.email', 'pin-context-test@example.invalid');
  git('add', 'fixture.ts');
  git('commit', '-m', 'Create integration fixture');

  await runTests({
    version: 'stable',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'test-integration', 'suite', 'index.cjs'),
    launchArgs: [
      workspace,
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
      '--disable-workspace-trust',
      '--skip-welcome'
    ]
  });
}

main()
  .catch((error) => {
    console.error('VS Code integration tests failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const target of [workspace, userDataDir, extensionsDir]) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
