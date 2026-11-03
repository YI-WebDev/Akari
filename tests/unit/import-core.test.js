import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeZip } from './_zip.js';
import { parseCsv, csvToObjects, toCsv, pick } from '../../extension/src/lib/import/csv.js';
import { readZip, findEntry } from '../../extension/src/lib/import/zip.js';
import { makeImported, parseOtp, isPgp, isZip, toMs, bytesToText } from '../../extension/src/lib/import/model.js';

test('parseCsv: quotes, escaped quotes, embedded newlines, CRLF, BOM', () => {
  const rows = parseCsv('﻿name,url,note\r\n"a, b","https://x.test","line1\nline2 ""q"""\r\nc,,\r\n\r\n');
  assert.deepEqual(rows, [['name', 'url', 'note'], ['a, b', 'https://x.test', 'line1\nline2 "q"'], ['c', '', '']]);
});

test('parseCsv: semicolon and tab delimiters are detected', () => {
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});

test('csvToObjects + pick', () => {
  const { headers, records } = csvToObjects('Name,URL,Username\nGitHub,https://github.com,alice\n');
  assert.deepEqual(headers, ['name', 'url', 'username']);
  assert.equal(pick(records[0], 'title', 'name'), 'GitHub');
});

test('toCsv round-trips through parseCsv', () => {
  const rows = [['name', 'note'], ['a,"b"', 'x\ny'], [' lead', 'ok']];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test('readZip: deflate and stored entries, findEntry by basename', async () => {
  for (const deflate of [true, false]) {
    const z = makeZip({ 'Proton Pass/data.json': '{"ok":true}', 'files/a.txt': 'あいう' }, { deflate });
    assert.ok(isZip(z));
    const entries = readZip(z);
    assert.equal(entries.length, 2);
    assert.equal(await findEntry(entries, 'data.json').text(), '{"ok":true}');
    assert.equal(await findEntry(entries, 'files/a.txt').text(), 'あいう');
  }
});

test('readZip refuses a bomb without inflating it (security review #1)', async () => {
  const { deflateRawSync } = await import('node:zlib');
  const huge = deflateRawSync(Buffer.alloc(80 * 2 ** 20)); // 80 MiB of zeros → ~80 KB
  // Lying header (declares 1 byte): inflation stops as soon as output passes it.
  const t0 = Date.now();
  await assert.rejects(readZip(buildRaw('a.json', huge, 1))[0].bytes(), (e) => e.code === 'INVALID_FORMAT');
  assert.ok(Date.now() - t0 < 2000, 'must stop as soon as the output passes the declared size');
  // Honest header over the per-entry cap: refused before inflating.
  const declaredHuge = buildRaw('b.json', huge, 80 * 2 ** 20);
  await assert.rejects(readZip(declaredHuge)[0].bytes(), (e) => e.code === 'UNSUPPORTED');
});

test('CSV caps rows and columns (security review #3)', () => {
  assert.throws(() => parseCsv('a,'.repeat(300) + 'z\n'), (e) => e.code === 'UNSUPPORTED');
  assert.throws(() => parseCsv('a\n'.repeat(50002)), (e) => e.code === 'UNSUPPORTED');
  const t0 = Date.now();
  parseCsv(('x,'.repeat(255) + 'y\n').repeat(3000));
  assert.ok(Date.now() - t0 < 2000);
});

/** One deflated entry whose central/local headers declare `usize` bytes. */
function buildRaw(name, body, usize) {
  const nameB = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(body.length, 18); local.writeUInt32LE(usize, 22); local.writeUInt16LE(nameB.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(body.length, 20); central.writeUInt32LE(usize, 24); central.writeUInt16LE(nameB.length, 28);
  const cdOff = 30 + nameB.length + body.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + nameB.length, 12); end.writeUInt32LE(cdOff, 16);
  return new Uint8Array(Buffer.concat([local, nameB, body, central, nameB, end]));
}

test('model helpers', () => {
  assert.equal(makeImported({ type: 'login' }), null);
  const it = makeImported({ url: 'https://accounts.google.com/x', username: ' a ', password: ' p ' });
  assert.equal(it.title, 'accounts.google.com');
  assert.equal(it.username, 'a');
  assert.equal(it.password, ' p ');
  assert.equal(parseOtp('JBSW Y3DP EHPK 3PXP').secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(parseOtp('otpauth://totp/X:a?secret=JBSWY3DPEHPK3PXP&digits=8').digits, 8);
  assert.equal(parseOtp('steam://ABC'), null);
  assert.equal(toMs(1700000000), 1700000000000);
  assert.equal(toMs('2024-01-02T03:04:05Z'), Date.UTC(2024, 0, 2, 3, 4, 5));
  assert.ok(isPgp(new TextEncoder().encode('-----BEGIN PGP MESSAGE-----\n\nxx')));
  assert.ok(isPgp(new Uint8Array([0xc3, 0x0d])));
  assert.ok(!isPgp(new TextEncoder().encode('{"a":1}')));
  assert.equal(bytesToText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), 'a');
});
