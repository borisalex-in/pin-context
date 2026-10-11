import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { updateDocsVersionLabel, updateReadmeVersionBadge } from '../scripts/versionMetadata';

test('release version metadata updates the README badge', () => {
  const source =
    '[![Version](https://img.shields.io/badge/version-0.0.6-blue.svg)](https://example.com)';
  assert.equal(
    updateReadmeVersionBadge(source, '0.0.7'),
    '[![Version](https://img.shields.io/badge/version-0.0.7-blue.svg)](https://example.com)'
  );
});

test('release version metadata updates only the version label in the docs hero meta', () => {
  const source = `<div class="hero-meta" aria-label="Extension details">
  <span>v0.0.6</span>
  <span>VS Code ≥ 1.102</span>
  <span>MIT License</span>
  <span data-i18n="hero-meta-json">JSON import / export</span>
</div>`;
  const updated = updateDocsVersionLabel(source, '0.0.7');

  assert.match(updated, /<span>v0\.0\.7<\/span>/);
  assert.match(updated, /<span>VS Code ≥ 1\.102<\/span>/);
  assert.match(updated, /<span>MIT License<\/span>/);
  assert.match(updated, /JSON import \/ export/);
  assert.doesNotMatch(updated, /<span>v0\.0\.6<\/span>/);
});

test('release version metadata fails loudly if a version marker is missing', () => {
  assert.throws(
    () => updateReadmeVersionBadge('# README without a version badge', '0.0.7'),
    /Expected exactly one README version badge/
  );
  assert.throws(
    () => updateDocsVersionLabel('<div class="hero-meta"><span>MIT License</span></div>', '0.0.7'),
    /Could not find a version label/
  );
});

test('npm version lifecycle is wired to update the README and website version labels', () => {
  const root = path.resolve(__dirname, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const versionScript = packageJson.scripts?.version ?? '';

  assert.match(versionScript, /scripts\/update-version-metadata\.ts/);
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'update-version-metadata.ts')));
  assert.ok(fs.existsSync(path.join(root, 'docs', 'index.html')));
});
