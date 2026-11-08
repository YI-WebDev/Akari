import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MSG, ERR } from '../../extension/src/shared/messages.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../extension/src');
const TESTS = path.resolve(HERE, '..');
const NAMESPACES = ['vault', 'settings', 'clipboard', 'activity', 'autofill', 'passkey', 'offscreen'];
const TYPE_LITERAL = new RegExp(`['"\`]((?:${NAMESPACES.join('|')})/[A-Za-z]+)['"\`]`, 'g');

const SENT_BY_SW = {
  AUTOFILL_DO_FILL: 'content/autofill.js',
  OFFSCREEN_CLEAR_CLIPBOARD: 'offscreen/offscreen.js',
};

async function jsFiles(dir) {
  const names = await readdir(dir, { recursive: true });
  const files = names.filter((n) => n.endsWith('.js') && !n.split(/[\\/]/).includes('third_party') && !n.split(/[\\/]/).includes('node_modules'));
  return Promise.all(files.map(async (n) => ({ name: n.replaceAll('\\', '/'), text: await readFile(path.join(dir, n), 'utf8') })));
}

const src = await jsFiles(SRC);
const tests = await jsFiles(TESTS);
const values = new Set(Object.values(MSG));
const matches = (text, re) => [...text.matchAll(re)].map((m) => m[1]);

test('MSG values are unique namespace/name strings', () => {
  assert.equal(values.size, Object.keys(MSG).length, 'two keys share a value');
  for (const [key, v] of Object.entries(MSG)) {
    assert.match(v, new RegExp(`^(${NAMESPACES.join('|')})/[A-Za-z]+$`), key);
  }
});

test('every message type written as a string is listed in MSG', () => {
  const unknown = [];
  for (const f of src) {
    if (f.name === 'shared/messages.js') continue;
    for (const type of matches(f.text, TYPE_LITERAL)) if (!values.has(type)) unknown.push(`${f.name}: ${type}`);
  }
  assert.deepEqual(unknown, []);
});

test('the classic scripts that hard-code types use the MSG values', () => {
  const used = (file) => new Set(matches(src.find((f) => f.name === file).text, TYPE_LITERAL));
  const autofill = used('content/autofill.js');
  for (const key of ['AUTOFILL_PAGE_MATCHES', 'AUTOFILL_REQUEST_FILL', 'AUTOFILL_OFFER_SAVE', 'AUTOFILL_CONFIRM_SAVE', 'AUTOFILL_NOTE_USERNAME', 'AUTOFILL_DO_FILL']) {
    assert.ok(autofill.has(MSG[key]), `content/autofill.js lacks ${MSG[key]}`);
  }
  const bridge = used('content/webauthn-bridge.js');
  for (const key of ['PASSKEY_CREATE', 'PASSKEY_GET', 'PASSKEY_ASSERT', 'PASSKEY_SAVE', 'PASSKEY_CANCEL']) {
    assert.ok(bridge.has(MSG[key]), `content/webauthn-bridge.js lacks ${MSG[key]}`);
  }
});

test('every MSG type has a receiver', () => {
  const background = src.filter((f) => f.name.startsWith('background/')).map((f) => f.text).join('\n');
  const registered = new Set([
    ...matches(background, /register\(\s*MSG\.([A-Z_]+)/g),
    ...matches(background, /\[MSG\.([A-Z_]+)\]\s*:/g),
  ]);
  const missing = [];
  for (const key of Object.keys(MSG)) {
    if (SENT_BY_SW[key]) {
      const receiver = src.find((f) => f.name === SENT_BY_SW[key]);
      if (!receiver.text.includes(`'${MSG[key]}'`)) missing.push(`${key} (not handled in ${SENT_BY_SW[key]})`);
    } else if (!registered.has(key)) {
      missing.push(`${key} (no handler registered in background/)`);
    }
  }
  assert.deepEqual(missing, []);
});

test('handlers are registered only under MSG types', () => {
  const background = src.filter((f) => f.name.startsWith('background/') && f.name !== 'background/router.js');
  const odd = [];
  for (const f of background) {
    for (const arg of matches(f.text, /\bregister\(\s*([^,\s]+)\s*,/g)) {
      if (!/^MSG\.[A-Z_]+$/.test(arg) && !(f.name === 'background/vault-service.js' && arg === 'type')) odd.push(`${f.name}: ${arg}`);
    }
  }
  assert.deepEqual(odd, []);
});

test('every MSG.* and ERR.* reference exists', () => {
  const unknown = [];
  for (const f of [...src, ...tests.map((t) => ({ ...t, name: 'tests/' + t.name }))]) {
    for (const key of matches(f.text, /\bMSG\.([A-Z_][A-Z0-9_]*)\b/g)) if (!Object.hasOwn(MSG, key)) unknown.push(`${f.name}: MSG.${key}`);
    for (const key of matches(f.text, /\bERR\.([A-Z_][A-Z0-9_]*)\b/g)) if (!Object.hasOwn(ERR, key)) unknown.push(`${f.name}: ERR.${key}`);
  }
  assert.deepEqual(unknown, []);
});

test('error codes thrown as string literals are listed in ERR', () => {
  const unknown = [];
  for (const f of src) {
    if (f.name.startsWith('lib/import/')) continue;
    for (const code of matches(f.text, /\b(?:fail|AkariError)\(\s*'([A-Z_]+)'/g)) if (!Object.hasOwn(ERR, code)) unknown.push(`${f.name}: ${code}`);
  }
  assert.deepEqual(unknown, []);
});
