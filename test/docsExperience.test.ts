import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'docs', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'docs', 'styles.css'), 'utf8');
const script = fs.readFileSync(path.join(root, 'docs', 'script.js'), 'utf8');
const en = JSON.parse(
  fs.readFileSync(path.join(root, 'docs', 'i18n', 'en.json'), 'utf8')
) as Record<string, string>;
const ru = JSON.parse(
  fs.readFileSync(path.join(root, 'docs', 'i18n', 'ru.json'), 'utf8')
) as Record<string, string>;

test('docs page keeps the chosen 1320px content width without a mobile override', () => {
  const pageRules = css.match(/\.page\s*\{[^}]*\}/g) ?? [];
  assert.equal(pageRules.length, 1, 'the .page rule should be defined once');
  assert.match(pageRules[0], /width:\s*min\(1320px, calc\(100% - 2\.5rem\)\)/);
  assert.match(pageRules[0], /margin:\s*0 auto/);
  assert.match(pageRules[0], /padding:\s*1\.25rem 0 2\.5rem/);
});

test('responsive navigation has an accessible burger menu and valid section links', () => {
  const navToggleTag = html.match(/<button\b[^>]*\bid="navToggle"[^>]*>/s)?.[0];
  assert.ok(navToggleTag, 'missing navigation toggle button');
  assert.match(navToggleTag, /\baria-expanded="false"/);
  assert.match(navToggleTag, /\baria-controls="siteNav"/);

  const navTag = [...html.matchAll(/<nav\b[^>]*>/gs)]
    .map((match) => match[0])
    .find((tag) => /\bclass="nav"/.test(tag) && /\bid="siteNav"/.test(tag));
  assert.ok(navTag, 'missing primary navigation element with id="siteNav"');
  assert.match(css, /(^|\n)\.nav\s*\{\s*display:\s*none/s);
  assert.match(css, /\.topbar \.nav\s*\{[^}]*display:\s*none/s);
  assert.match(css, /\.topbar \.nav\.open\s*\{\s*display:\s*flex/s);
  assert.match(css, /\.nav-toggle\s*\{[^}]*display:\s*inline-flex/s);
  const burgerRulesStart = css.indexOf('/* Navigation is always a collapsed burger menu');
  assert.ok(burgerRulesStart >= 0, 'missing global burger-only navigation rules');
  const burgerRulesEnd = css.indexOf('@media', burgerRulesStart);
  const globalBurgerRules = css.slice(
    burgerRulesStart,
    burgerRulesEnd < 0 ? undefined : burgerRulesEnd
  );
  assert.match(globalBurgerRules, /\.topbar \.nav\s*\{[^}]*display:\s*none/s);
  assert.match(globalBurgerRules, /\.topbar \.nav\.open\s*\{\s*display:\s*flex/s);
  assert.match(script, /function initializeNavigation\(\)/);
  assert.match(script, /event\.key === 'Escape'/);
  assert.doesNotMatch(
    script,
    /innerWidth\s*>\s*1200/,
    'navigation must remain a burger menu and stay toggleable on every viewport width'
  );

  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'HTML IDs must be unique');
  const sectionLinks = [...html.matchAll(/href="#([^"#]*)"/g)]
    .map((match) => match[1])
    .filter(Boolean);
  for (const target of sectionLinks) {
    assert.ok(ids.includes(target), `missing target for #${target}`);
  }
});

test('feature list explains AI-agent integration in English and Russian', () => {
  assert.match(html, /data-i18n="feature-9-title"/);
  assert.match(html, /data-i18n="feature-9-desc"/);
  for (const key of ['feature-9-title', 'feature-9-desc']) {
    assert.ok(en[key], `missing English translation: ${key}`);
    assert.ok(ru[key], `missing Russian translation: ${key}`);
  }
});

test('Why Pin Context comparison lists current capabilities with equal item counts', () => {
  const baseline = html.match(
    /<div class="comparison-panel active" data-panel="vscode">([\s\S]*?)<\/div>/
  )?.[1];
  const product = html.match(
    /<div class="comparison-panel" data-panel="pincontext">([\s\S]*?)<\/div>/
  )?.[1];
  assert.ok(baseline, 'missing baseline comparison panel');
  assert.ok(product, 'missing Pin Context comparison panel');
  assert.equal([...baseline.matchAll(/<li\b/g)].length, 8);
  assert.equal([...product.matchAll(/<li\b/g)].length, 8);

  for (let i = 1; i <= 8; i += 1) {
    for (const prefix of ['cmp-vscode-', 'cmp-pin-']) {
      const key = `${prefix}${i}`;
      assert.ok(en[key], `missing English translation: ${key}`);
      assert.ok(ru[key], `missing Russian translation: ${key}`);
    }
  }
});

test('AI flow diagram is interactive, localized, and respects reduced motion', () => {
  const nodeMatches = [...html.matchAll(/data-agent-flow="([^"]+)"/g)];
  assert.deepEqual(
    nodeMatches.map((match) => match[1]),
    ['context', 'mcp', 'claude', 'codex']
  );
  const flowStageTag = [...html.matchAll(/<div\b[^>]*>/gs)]
    .map((match) => match[0])
    .find((tag) => /\bclass="[^"]*\bagent-flow-stage\b[^"]*"/.test(tag));
  assert.ok(flowStageTag, 'missing AI flow stage container');
  assert.match(flowStageTag, /\brole="group"/);
  assert.match(script, /function initializeAgentFlow\(\)/);
  assert.match(script, /function updateAgentFlow\(\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.agent-flow-path/);

  const flowKeys = [
    'agent-flow-aria',
    'agent-flow-stage-aria',
    'agent-flow-title',
    'agent-flow-badge',
    'agent-flow-context',
    'agent-flow-mcp',
    'agent-flow-claude',
    'agent-flow-codex',
    'agent-flow-context-title',
    'agent-flow-context-desc',
    'agent-flow-mcp-title',
    'agent-flow-mcp-desc',
    'agent-flow-claude-title',
    'agent-flow-claude-desc',
    'agent-flow-codex-title',
    'agent-flow-codex-desc'
  ];
  for (const key of flowKeys) {
    assert.ok(en[key], `missing English translation: ${key}`);
    assert.ok(ru[key], `missing Russian translation: ${key}`);
  }
});

test('English and Russian documentation dictionaries have matching keys and placeholders', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort());
  for (const key of Object.keys(en)) {
    const enPlaceholders = [...en[key].matchAll(/\{\d+\}/g)].map((match) => match[0]).sort();
    const ruPlaceholders = [...ru[key].matchAll(/\{\d+\}/g)].map((match) => match[0]).sort();
    assert.deepEqual(ruPlaceholders, enPlaceholders, `placeholder mismatch for ${key}`);
  }
});
