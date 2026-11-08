import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  passwordHealth, primaryIssue, passwordAgeDays, passwordSetAt, ISSUES, OLD_AFTER_DAYS,
} from '../../extension/src/lib/health.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 5);
const STRONG = 'v8#Lq2!mTz9@rWk4pE';
const TOTP = { secret: 'JBSWY3DPEHPK3PXP' };
const PASSKEY = { credentialId: 'x', rpId: 'example.com' };

let n = 0;
function login(props = {}) {
  n++;
  return {
    id: 'i' + n, type: 'login', title: 't', password: STRONG + n, totp: TOTP, passkeys: [],
    createdAt: NOW - 10 * DAY, passwordUpdatedAt: NOW - 10 * DAY, ...props,
  };
}

test('a strong, unique, recent login with 2FA has no issues', () => {
  const h = passwordHealth([login()], { now: NOW });
  assert.equal(h.logins, 1);
  assert.equal(h.needsAction, 0);
  assert.deepEqual(h.counts, { weak: 0, reused: 0, old: 0, no2fa: 0 });
  assert.equal(h.issues.size, 0);
});

test('weak, reused, old and no2fa are found, in ISSUES order', () => {
  const weak = login({ password: 'password1' });
  const r1 = login({ password: 'Shared-Pa55-word!x' });
  const r2 = login({ password: 'Shared-Pa55-word!x', totp: null, passkeys: [PASSKEY] });
  const old = login({ passwordUpdatedAt: NOW - OLD_AFTER_DAYS * DAY });
  const bare = login({ totp: null });
  const all = login({ password: '1234', totp: null, passwordUpdatedAt: NOW - 800 * DAY });
  const twin = login({ password: '1234', passwordUpdatedAt: NOW - DAY });
  const h = passwordHealth([weak, r1, r2, old, bare, all, twin], { now: NOW });
  assert.deepEqual(h.issues.get(weak.id), ['weak']);
  assert.deepEqual(h.issues.get(r1.id), ['reused']);
  assert.deepEqual(h.issues.get(r2.id), ['reused'], 'a passkey counts as a second factor');
  assert.deepEqual(h.issues.get(old.id), ['old'], 'exactly OLD_AFTER_DAYS counts as old');
  assert.deepEqual(h.issues.get(bare.id), ['no2fa']);
  assert.deepEqual(h.issues.get(all.id), ['weak', 'reused', 'old', 'no2fa']);
  assert.deepEqual(h.issues.get(twin.id), ['weak', 'reused']);
  assert.deepEqual(h.counts, { weak: 3, reused: 4, old: 2, no2fa: 2 });
  assert.equal(h.logins, 7);
  assert.equal(h.needsAction, 6, 'every login but bare, whose only issue is advice');
  assert.equal(h.reuse.get(r1.id), 1);
  assert.equal(h.reuse.get(all.id), 1);
  assert.equal(h.reuse.has(weak.id), false);
  assert.equal(primaryIssue(h.issues.get(all.id)), 'weak');
  assert.equal(primaryIssue(undefined), null);
});

test('only logins with a password are judged', () => {
  const items = [
    login({ password: '' }),
    { id: 'n', type: 'note', title: 'メモ', password: '1234', createdAt: 1 },
    { id: 'c', type: 'card', title: 'カード', fields: { pin: '1234' }, createdAt: 1 },
    null,
  ];
  const h = passwordHealth(items, { now: NOW });
  assert.equal(h.logins, 0);
  assert.equal(h.issues.size, 0);
  assert.deepEqual(passwordHealth(undefined, { now: NOW }).counts, Object.fromEntries(ISSUES.map((k) => [k, 0])));
});

test('age: passwordUpdatedAt first, else createdAt; unknown dates are never old', () => {
  const imported = login({ passwordUpdatedAt: null, createdAt: NOW - 400 * DAY });
  const unknown = login({ passwordUpdatedAt: null, createdAt: undefined });
  const h = passwordHealth([imported, unknown], { now: NOW });
  assert.deepEqual(h.issues.get(imported.id), ['old']);
  assert.equal(h.issues.has(unknown.id), false);
  assert.equal(passwordSetAt(unknown), null);
  assert.equal(passwordAgeDays(imported, NOW), 400);
  assert.equal(passwordAgeDays(unknown, NOW), null);
});

test('the strength estimator and the age limit can be passed in', () => {
  const calls = [];
  const strength = (pw) => { calls.push(pw); return { level: pw === 'x' ? 0 : 4 }; };
  const it = login({ password: 'x', passwordUpdatedAt: NOW - 40 * DAY });
  const h = passwordHealth([it], { now: NOW, strength, oldAfterDays: 30 });
  assert.deepEqual(calls, ['x']);
  assert.deepEqual(h.issues.get(it.id), ['weak', 'old']);
});
