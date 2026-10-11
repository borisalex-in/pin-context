import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  version?: unknown;
};
if (typeof packageJson.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(packageJson.version)) {
  throw new Error('package.json must contain a valid stable version before package verification.');
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
let listing: string;
try {
  listing = execFileSync(npx, ['vsce', 'ls', '--no-dependencies'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // Windows launches npm command shims through cmd.exe.
    shell: process.platform === 'win32'
  });
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(
    `Could not list VSIX files with vsce. Ensure dependencies are installed. ${detail}`
  );
}

const files = new Set(
  listing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('['))
    .map((line) => line.replace(/^\.\//, '').replace(/\\/g, '/'))
);

const required = [
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'package.json',
  'api.d.ts',
  'package.nls.json',
  'package.nls.ru.json',
  'out/extension.js',
  'out/mcp-server.js',
  'l10n/bundle.l10n.json',
  'l10n/bundle.l10n.ru.json',
  'images/icon.png',
  'images/icon-btc.png',
  'images/icon-eth.png',
  'images/icon-trc.png',
  'images/icon-sol.png'
];
const missing = required.filter((file) => !files.has(file));
if (missing.length > 0) {
  throw new Error(
    `VSIX package is missing required runtime/marketplace files:\n- ${missing.join('\n- ')}`
  );
}

const forbiddenPatterns: Array<[string, RegExp]> = [
  ['source tree', /^src\//],
  ['unit tests', /^test\//],
  ['integration tests', /^test-integration\//],
  ['build/release scripts', /^scripts\//],
  ['static documentation site', /^docs\//],
  ['temporary files', /^tmp\//],
  ['GitHub workflow files', /^\.github\//],
  ['macOS archive metadata', /(^|\/)__MACOSX\//],
  ['macOS resource forks', /(^|\/)\._[^/]+$/],
  ['Finder metadata', /(^|\/)\.DS_Store$/],
  ['Git ignore/config files', /^\.gitignore$|^\.vscodeignore$/],
  ['source maps', /\.map$/],
  ['TypeScript build metadata', /\.tsbuildinfo$/],
  ['dependency lockfile', /^package-lock\.json$/],
  ['TypeScript configs', /^tsconfig[^/]*\.json$/],
  ['ESLint config', /^eslint\.config\.mjs$/],
  ['Prettier config', /^\.prettierrc\.json$/],
  ['repository Markdown documentation', /^(?!README\.md$|CHANGELOG\.md$).+\.md$/i]
];
const forbidden = [...files].flatMap((file) => {
  const matches = forbiddenPatterns.filter(([, pattern]) => pattern.test(file));
  return matches.map(([label]) => `${file} (${label})`);
});
if (forbidden.length > 0) {
  throw new Error(`VSIX package contains repository-only files:\n- ${forbidden.join('\n- ')}`);
}

const expectedVsix = path.join(root, `pin-context-${packageJson.version}.vsix`);
if (!existsSync(expectedVsix) || statSync(expectedVsix).size < 10_000) {
  throw new Error(
    `Expected a non-empty VSIX for version ${packageJson.version} at ${path.basename(expectedVsix)}. Run npm run build:vsix first.`
  );
}

const vsixFiles = readdirSync(root).filter((name) => name.endsWith('.vsix'));
if (vsixFiles.length !== 1 || vsixFiles[0] !== path.basename(expectedVsix)) {
  throw new Error(
    `Expected exactly ${path.basename(expectedVsix)} in the project root, found: ${vsixFiles.join(', ') || 'none'}.`
  );
}

console.log(
  `[package] verified ${files.size} files for ${path.basename(expectedVsix)} (${statSync(expectedVsix).size} bytes).`
);
