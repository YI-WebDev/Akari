import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SHADOW = readFileSync(new URL('../../extension/src/content/shadow-ui.js', import.meta.url), 'utf8');
const TOKENS = readFileSync(new URL('../../extension/src/shared/tokens.css', import.meta.url), 'utf8');

function block(source, selector) {
  const start = `\n${source}`.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `missing block ${selector}`);
  const open = source.indexOf('{', start);
  const close = source.indexOf('}', open);
  return source.slice(open + 1, close);
}

function vars(body) {
  const out = new Map();
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].replace(/\s+/g, ' ').trim());
  }
  return out;
}

const shadowDark = vars(block(SHADOW, '.orb, .menu, .bar'));
const shadowLight = vars(block(SHADOW, ':is(.orb, .menu, .bar).light'));
const rootDark = vars(block(TOKENS, ':root'));
const rootLight = new Map([...rootDark, ...vars(block(TOKENS, ':root[data-theme="light"]'))]);

const plain = (value) => value.replace(/var\(--ak-/g, 'var(--');

function compare(shadow, tokens, label) {
  assert.ok(shadow.size > 0, `${label}: no --ak-* found`);
  for (const [name, value] of shadow) {
    assert.ok(name.startsWith('--ak-'), `${label}: ${name} is not an --ak-* name`);
    const base = '--' + name.slice('--ak-'.length);
    assert.ok(tokens.has(base), `${label}: tokens.css has no ${base} for ${name}`);
    assert.equal(plain(value), tokens.get(base), `${label}: ${name} differs from ${base}`);
  }
}

test('dark --ak-* values in shadow-ui.js match :root in tokens.css', () => {
  compare(shadowDark, rootDark, 'dark');
});

test('light --ak-* values in shadow-ui.js match the light theme in tokens.css', () => {
  compare(new Map([...shadowDark, ...shadowLight]), rootLight, 'light');
});

test('the light block overrides only names the dark block defines', () => {
  for (const name of shadowLight.keys()) assert.ok(shadowDark.has(name), `${name} is light-only`);
});
