// The popup's state object `S` (popup/state.js) is read everywhere but changed only by the
// functions in state.js. This reads the popup sources and fails on any other write to S.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const POPUP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../extension/src/popup');

// S.x = …, S.x.y = …, S.x++, S.x += …, and Set/Map changes on S.picked and friends
const WRITE = /\bS\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*(?:=(?!=)|\+\+|--|[-+*/|&]=)|\bS\.[A-Za-z_$][\w$]*\.(?:add|delete|clear|set|push|splice|pop|shift|unshift)\(/g;

test('only popup/state.js writes to S', async () => {
  const files = (await readdir(POPUP, { recursive: true })).filter((n) => n.endsWith('.js')).map((n) => n.replaceAll('\\', '/'));
  assert.ok(files.includes('popup.js') && files.includes('controllers/view.js'), 'popup sources found');
  const writes = [];
  for (const name of files) {
    if (name === 'state.js') continue;
    const lines = (await readFile(path.join(POPUP, name), 'utf8')).split('\n');
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      for (const m of code.matchAll(WRITE)) writes.push(`${name}:${i + 1}: ${m[0]}`);
    });
  }
  assert.deepEqual(writes, []);
});
