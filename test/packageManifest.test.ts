import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const readJson = <T>(file: string): T =>
  JSON.parse(readFileSync(path.join(root, file), 'utf8')) as T;

test('VSIX ignore rules exclude source/test material and keep runtime assets and changelog', () => {
  const ignore = readFileSync(path.join(root, '.vscodeignore'), 'utf8');
  for (const pattern of [
    'src/**',
    'test/**',
    'test-integration/**',
    'scripts/**',
    'docs/**',
    '__MACOSX/**',
    '**/._*',
    '.prettierrc.json'
  ]) {
    assert.ok(ignore.includes(pattern), `missing VSIX ignore pattern ${pattern}`);
  }
  assert.ok(
    /^\*\*\/\*\.md\s*$/m.test(ignore),
    'repository Markdown docs should be excluded by default'
  );
  assert.ok(/^!README\.md\s*$/m.test(ignore), 'README should be explicitly included');
  assert.ok(/^!CHANGELOG\.md\s*$/m.test(ignore), 'CHANGELOG should be explicitly included');
  assert.ok(!/^CHANGELOG\.md\s*$/m.test(ignore), 'CHANGELOG should be packaged');
  assert.ok(!/^images\/\*\*\s*$/m.test(ignore), 'README support icons must remain packageable');
});

test('published manifest matches the VS Code API baseline and declares a stable public types entry', () => {
  const pkg = readJson<{
    version: string;
    engines: { vscode: string };
    devDependencies: Record<string, string>;
    types: string;
    activationEvents: string[];
    categories: string[];
    galleryBanner?: { color: string; theme: string };
    sponsor?: { url: string };
    contributes: { mcpServerDefinitionProviders: Array<{ id: string; label: string }> };
  }>('package.json');
  const lock = readJson<{
    packages: {
      '': { version: string; devDependencies: Record<string, string> };
      'node_modules/@types/vscode': { version: string; integrity?: string };
    };
  }>('package-lock.json');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.engines.vscode, '^1.102.0');
  assert.equal(pkg.devDependencies['@types/vscode'], '1.102.0');
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(lock.packages[''].devDependencies['@types/vscode'], '1.102.0');
  assert.deepEqual(
    lock.packages[''].devDependencies,
    pkg.devDependencies,
    'package-lock root devDependencies must match package.json'
  );
  assert.equal(lock.packages['node_modules/@types/vscode'].version, '1.102.0');
  assert.match(lock.packages['node_modules/@types/vscode'].integrity ?? '', /^sha512-/);
  assert.equal(pkg.types, './api.d.ts');
  assert.ok(pkg.activationEvents.includes('onStartupFinished'));
  assert.deepEqual(pkg.categories, ['Other']);
  assert.equal(pkg.galleryBanner?.theme, 'dark');
  assert.ok(pkg.sponsor?.url.includes('#-support-the-project'));
  assert.equal(pkg.contributes.mcpServerDefinitionProviders[0].label, '%pinContext%');
});

test('package localization files contain every enum description key used by package.json', () => {
  const pkg = readJson<{
    contributes: { configuration: { properties: Record<string, { enumDescriptions?: string[] }> } };
  }>('package.json');
  const en = readJson<Record<string, string>>('package.nls.json');
  const ru = readJson<Record<string, string>>('package.nls.ru.json');
  for (const [setting, definition] of Object.entries(pkg.contributes.configuration.properties)) {
    for (const key of definition.enumDescriptions ?? []) {
      const localizedKey = key.match(/^%(.+)%$/)?.[1];
      assert.ok(localizedKey, `${setting} enumDescriptions entries must use localization keys`);
      assert.ok(en[localizedKey!], `missing English package localization ${localizedKey}`);
      assert.ok(ru[localizedKey!], `missing Russian package localization ${localizedKey}`);
    }
  }
});
