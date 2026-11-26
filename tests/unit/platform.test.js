import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../extension/src');
const MOD = new URL('../../extension/src/shared/platform.js', import.meta.url).href;
let n = 0;

async function load(injected) {
  if (injected === undefined) delete globalThis.__akariPlatform;
  else globalThis.__akariPlatform = injected;
  try {
    return (await import(`${MOD}?case=${++n}`)).platform;
  } finally {
    delete globalThis.__akariPlatform;
  }
}

test('extension defaults without __akariPlatform', async () => {
  const p = await load();
  assert.equal(p.kind, 'extension');
  assert.deepEqual(p.can, { autofill: true, passkeyPage: true, appFill: false, captureQr: true, startFromBackup: false });
  assert.equal(typeof p.saveFile, 'function');
  assert.equal(typeof p.copy, 'function');
  assert.equal(typeof p.captureQr, 'function');
  assert.equal(p.startFromBackup, undefined);
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.can));
});

test('a non-desktop value is ignored', async () => {
  for (const v of [null, 'desktop', 1, { kind: 'other', can: { autofill: false } }, { can: { autofill: false } }]) {
    const p = await load(v);
    assert.equal(p.kind, 'extension');
    assert.equal(p.can.autofill, true);
  }
});

test('desktop object is used', async () => {
  const calls = [];
  const p = await load({
    kind: 'desktop',
    can: { autofill: false, passkeyPage: false, appFill: true, captureQr: false, startFromBackup: true },
    saveFile: async (name, blob) => { calls.push(['save', name, blob]); return false; },
    copy: async (value, opts) => { calls.push(['copy', value, opts]); },
    startFromBackup: async () => { calls.push(['start']); },
  });
  assert.equal(p.kind, 'desktop');
  assert.deepEqual(p.can, { autofill: false, passkeyPage: false, appFill: true, captureQr: false, startFromBackup: true });
  assert.equal(await p.saveFile('a.json', 'blob'), false);
  await p.copy('v', { secret: true });
  await p.startFromBackup();
  assert.deepEqual(calls, [['save', 'a.json', 'blob'], ['copy', 'v', { secret: true }], ['start']]);
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.can));
});

test('unknown keys and wrong types are ignored', async () => {
  const p = await load({
    kind: 'desktop',
    extra: () => {},
    can: { autofill: 'no', appFill: 1, captureQr: false, bogus: true },
    saveFile: 'x',
    copy: 42,
    captureQr: null,
  });
  assert.equal(p.kind, 'desktop');
  assert.deepEqual(p.can, { autofill: true, passkeyPage: true, appFill: false, captureQr: false, startFromBackup: false });
  assert.equal(p.extra, undefined);
  assert.equal(typeof p.saveFile, 'function');
  assert.equal(typeof p.copy, 'function');
  assert.equal(p.startFromBackup, undefined);
});

test('extension copy looks up navigator.clipboard at call time', async () => {
  const p = await load();
  const orig = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const seen = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (v) => { seen.push(v); } } } });
  try {
    await p.copy('secret', { secret: true });
  } finally {
    if (orig) Object.defineProperty(globalThis, 'navigator', orig); else delete globalThis.navigator;
  }
  assert.deepEqual(seen, ['secret']);
});

async function files(dir) {
  return (await readdir(path.join(SRC, dir), { recursive: true })).filter((f) => f.endsWith('.js')).map((f) => `${dir}/${f.split(path.sep).join('/')}`);
}

test('host-specific APIs are used only in shared/platform.js', async () => {
  const BAD = /navigator\.clipboard\.writeText|chrome\.tabs\.captureVisibleTab|\.download\s*=(?!=)/;
  const bad = [];
  for (const f of [...await files('popup'), ...await files('shared')]) {
    if (f === 'shared/platform.js' || f.startsWith('shared/locales/')) continue;
    const src = await readFile(path.join(SRC, f), 'utf8');
    src.split('\n').forEach((line, i) => { if (BAD.test(line.replace(/\/\/.*$/, ''))) bad.push(`${f}:${i + 1}`); });
  }
  assert.deepEqual(bad, []);
});

test('background/ does not import shared/platform.js', async () => {
  const bad = [];
  for (const f of await files('background')) {
    if (/platform\.js/.test(await readFile(path.join(SRC, f), 'utf8'))) bad.push(f);
  }
  assert.deepEqual(bad, []);
});
