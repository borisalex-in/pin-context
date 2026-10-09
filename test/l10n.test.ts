import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

/**
 * Regresses: bundle.ru.l10n.json was installed instead of bundle.l10n.ru.json,
 * which caused VS Code to never load the translation and the sidebar always
 * showed English strings.
 */

test('l10n bundle filenames follow VS Code convention', () => {
  const l10nDir = path.join(__dirname, '..', 'l10n');
  const files = fs.readdirSync(l10nDir);

  // There must be exactly one default (English) template.
  const defaultBundle = files.find((f) => f === 'bundle.l10n.json');
  assert.ok(defaultBundle, 'bundle.l10n.json must exist as the translation template');

  // Every other file must match the VS Code convention:
  //   bundle.l10n.<language>.json   (NOT bundle.<language>.l10n.json)
  const localePattern = /^bundle\.l10n\.([a-z\-]+)\.json$/;
  const localeFiles = files.filter((f) => f !== 'bundle.l10n.json');
  const badNames: string[] = [];

  for (const file of localeFiles) {
    const match = localePattern.exec(file);
    if (!match) {
      badNames.push(file);
      continue;
    }
    const lang = match[1];
    assert.ok(lang.length > 0, `l10n/${file} has a valid language code: ${lang}`);
  }

  assert.deepEqual(
    badNames,
    [],
    `l10n filenames must match bundle.l10n.<lang>.json, found: ${badNames.join(', ')}`
  );
});

/**
 * Ensures every t("...") literal call site in src/ has a matching key
 * in the English template — so stale/missing translations are caught early.
 */
test('all t("...") literals exist in the English bundle', () => {
  const l10nDir = path.join(__dirname, '..', 'l10n');
  const en = JSON.parse(fs.readFileSync(path.join(l10nDir, 'bundle.l10n.json'), 'utf8')) as Record<
    string,
    string
  >;
  const keys = new Set(Object.keys(en));

  function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : e.name.endsWith('.ts') ? [p] : [];
    });
  }

  const srcFiles = walk(path.join(__dirname, '..', 'src'));
  const used = new Set<string>();
  const missing: string[] = [];

  for (const file of srcFiles) {
    const src = fs.readFileSync(file, 'utf8');
    // Match t("...") or t('...') — skip l10n.ts wrapper definition itself.
    if (file.endsWith('l10n.ts')) continue;
    const re = /(^|[^\w.$])t\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const start = m.index + m[0].length;
      let depth = 1,
        i = start;
      while (i < src.length && depth > 0) {
        if (src[i] === '(') depth++;
        if (src[i] === ')') depth--;
        i++;
      }
      const arg = src.slice(start, i - 1).trim();
      const q = arg.match(/^(['"])(.*?)\1/s);
      if (q) {
        const key = q[2];
        used.add(key);
        if (!keys.has(key)) missing.push(key);
      }
    }
  }

  assert.deepEqual(missing, [], `t("...") literals not in EN bundle: ${missing.length} keys`);
});

/**
 * Ensures every key in the English template has a translation in the RU bundle
 * with the same set of positional placeholders ({0}, {1}, …).
 */
test('RU bundle has translation for every EN key with matching placeholders', () => {
  const l10nDir = path.join(__dirname, '..', 'l10n');
  const en = JSON.parse(fs.readFileSync(path.join(l10nDir, 'bundle.l10n.json'), 'utf8')) as Record<
    string,
    string
  >;
  const ru = JSON.parse(
    fs.readFileSync(path.join(l10nDir, 'bundle.l10n.ru.json'), 'utf8')
  ) as Record<string, string>;

  const enPh = (s: string) =>
    [...String(s).matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1])).sort((a, b) => a - b);

  const missingKeys: string[] = [];
  const mismatchedPh: string[] = [];

  for (const [key, enVal] of Object.entries(en)) {
    if (!(key in ru)) {
      missingKeys.push(key);
      continue;
    }
    const ruVal = ru[key];
    if (JSON.stringify(enPh(enVal)) !== JSON.stringify(enPh(ruVal))) {
      mismatchedPh.push(key);
    }
  }

  assert.deepEqual(missingKeys, [], `EN keys missing RU translation: ${missingKeys.join(', ')}`);
  assert.deepEqual(mismatchedPh, [], `Placeholder mismatch (EN vs RU): ${mismatchedPh.join(', ')}`);
});
