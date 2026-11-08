import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, compileQuery, looseMatch } from '../../extension/src/popup/search.js';

const norm = (s) => String(s || '').normalize('NFKC').toLowerCase();
const VAULTS = { personal: '個人', work: '仕事' };
const ISSUES = { a: ['weak', 'reused'], b: ['old', 'no2fa'] };
const ctx = {
  issuesOf: (it) => ISSUES[it.id] || [],
  vaultName: (id) => VAULTS[id] || '',
  textOf: (it) => ({ title: norm(it.title), rest: norm([it.username, it.url].filter(Boolean).join('\n')) }),
};
const ITEMS = [
  { id: 'a', type: 'login', vault: 'personal', title: 'Amazon', username: 'haruka@example.jp', url: 'https://amazon.co.jp', totp: { secret: 'X' }, fav: true },
  { id: 'b', type: 'login', vault: 'work', title: 'GitHub', username: 'dev', url: 'https://github.com', passkeys: [{ credentialId: 'c' }] },
  { id: 'c', type: 'card', vault: 'personal', title: '楽天カード' },
  { id: 'd', type: 'note', vault: 'work', title: '会議メモ' },
];
const find = (q) => {
  const m = compileQuery(q, ctx);
  const hits = ITEMS.filter((it) => m.test(it)).map((it) => it.id);
  return hits.length || !m.text ? hits : ITEMS.filter((it) => m.loose(it)).map((it) => it.id);
};

test('parseQuery: operators come out, the rest is the text', () => {
  assert.deepEqual(parseQuery('  type:login  ama  -has:TOTP '), {
    text: 'ama',
    ops: [{ key: 'type', value: 'login', neg: false }, { key: 'has', value: 'totp', neg: true }],
  });
  assert.deepEqual(parseQuery('https://x.jp foo:bar has:nothing type:'), { text: 'https://x.jp foo:bar has:nothing', ops: [] }, 'URLs, unknown keys and unknown values stay text; an operator still being typed is ignored');
});

test('type / has / is / vault, alone and together', () => {
  assert.deepEqual(find('type:login'), ['a', 'b']);
  assert.deepEqual(find('type:カード'), ['c'], 'by a part of the type name (クレジットカード)');
  assert.deepEqual(find('type:no'), ['d'], 'by the start of the id');
  assert.deepEqual(find('has:totp'), ['a']);
  assert.deepEqual(find('has:passkey'), ['b']);
  assert.deepEqual(find('has:2fa'), ['a', 'b']);
  assert.deepEqual(find('has:url'), ['a', 'b']);
  assert.deepEqual(find('is:weak'), ['a']);
  assert.deepEqual(find('is:old is:no2fa'), ['b']);
  assert.deepEqual(find('is:fav'), ['a']);
  assert.deepEqual(find('vault:仕事'), ['b', 'd']);
  assert.deepEqual(find('vault:work type:note'), ['d']);
  assert.deepEqual(find('-type:login'), ['c', 'd']);
  assert.deepEqual(find('type:login -has:totp'), ['b']);
  assert.deepEqual(find('type:zzz'), [], 'an unknown type finds nothing rather than everything');
});

test('text: one substring of the title or the non-secret text; loose title match only when nothing matches', () => {
  assert.deepEqual(find('example.jp'), ['a']);
  assert.deepEqual(find('git'), ['b']);
  assert.deepEqual(find('amzn'), ['a'], 'letters in order');
  assert.deepEqual(find('gthb'), ['b']);
  assert.deepEqual(find('q'), [], 'one letter never matches loosely');
  assert.deepEqual(find('type:card amzn'), [], 'operators still apply to loose matches');
  assert.equal(compileQuery('', ctx).empty, true);
  assert.equal(compileQuery('is:weak', ctx).empty, false);
});

test('looseMatch', () => {
  assert.equal(looseMatch('amazon', 'amzn'), true);
  assert.equal(looseMatch('amazon', 'nma'), false);
  assert.equal(looseMatch('anything', ''), true);
});
