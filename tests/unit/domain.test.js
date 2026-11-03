import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registrableDomain, sameSite, isValidRpId, isSecureOrigin, hostnameOf } from '../../extension/src/shared/domain.js';
import { toB64url, fromB64url, randomInt } from '../../extension/src/shared/bytes.js';

test('registrableDomain', () => {
  assert.equal(registrableDomain('accounts.google.com'), 'google.com');
  assert.equal(registrableDomain('www.amazon.co.jp'), 'amazon.co.jp');
  assert.equal(registrableDomain('jp.mercari.com'), 'mercari.com');
  assert.equal(registrableDomain('studio-mori.slack.com'), 'slack.com');
  assert.equal(registrableDomain('alice.github.io'), 'alice.github.io');
  assert.equal(registrableDomain('localhost'), 'localhost');
  assert.equal(registrableDomain('co.jp'), null);
  assert.equal(registrableDomain('intranet.unknown-tld-xyz'), null);
  assert.equal(registrableDomain('www.ck'), 'www.ck'); // PSL exception rule
  assert.equal(registrableDomain('a.b.ck'), 'a.b.ck'); // PSL wildcard rule
  assert.equal(registrableDomain('city.shibuya.tokyo.jp'), 'city.shibuya.tokyo.jp');
});

test('sameSite never pairs different owners under a public suffix (security review #1)', () => {
  for (const [a, b] of [
    ['bank.co.il', 'evil.co.il'], ['shop.com.pl', 'evil.com.pl'], ['bank.com.ua', 'evil.com.ua'],
    ['x.tokyo.jp', 'evil.tokyo.jp'], ['a.up.railway.app', 'evil.up.railway.app'],
    ['alice.myshopify.com', 'evil.myshopify.com'], ['a.s3.us-west-2.amazonaws.com', 'b.s3.us-west-2.amazonaws.com'],
    ['a.intranet.unknown-tld-xyz', 'b.intranet.unknown-tld-xyz'],
  ]) assert.ok(!sameSite('https://' + a, 'https://' + b), `${a} vs ${b}`);
  assert.ok(sameSite('https://intranet.unknown-tld-xyz', 'https://intranet.unknown-tld-xyz/login'));
  assert.ok(!isValidRpId('co.il', 'https://evil.co.il'));
  assert.ok(!isValidRpId('unknown-tld-xyz', 'https://a.unknown-tld-xyz'));
});

test('sameSite', () => {
  assert.ok(sameSite('https://github.com/login', 'https://github.com/session'));
  assert.ok(sameSite('accounts.google.com', 'https://mail.google.com/'));
  assert.ok(!sameSite('https://alice.github.io', 'https://bob.github.io'));
  assert.ok(!sameSite('https://amazon.co.jp', 'https://evil.co.jp'));
  assert.ok(!sameSite('https://github.com', 'https://github.com.evil.io'));
  assert.equal(hostnameOf('GitHub.com/login'), 'github.com');
});

test('isValidRpId', () => {
  assert.ok(isValidRpId('github.com', 'https://github.com'));
  assert.ok(isValidRpId('google.com', 'https://accounts.google.com'));
  assert.ok(isValidRpId('localhost', 'http://localhost:8080'));
  assert.ok(!isValidRpId('com', 'https://github.com'));
  assert.ok(!isValidRpId('co.jp', 'https://amazon.co.jp'));
  assert.ok(!isValidRpId('evil.com', 'https://github.com'));
  assert.ok(!isValidRpId('hub.com', 'https://github.com'));
  assert.ok(!isValidRpId('github.io', 'https://alice.github.io'));
});

test('isSecureOrigin', () => {
  assert.ok(isSecureOrigin('https://example.com'));
  assert.ok(isSecureOrigin('http://localhost:3000'));
  assert.ok(!isSecureOrigin('http://example.com'));
});

test('bytes helpers', () => {
  const b = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual(fromB64url(toB64url(b)), b);
  for (let i = 0; i < 1000; i++) {
    const n = randomInt(7);
    assert.ok(n >= 0 && n < 7);
  }
});
