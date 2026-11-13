import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanEmail, EMAIL_MAX_LENGTH } from '../../extension/src/shared/email.js';

test('cleanEmail accepts ordinary, plus and sub-domain addresses and trims them', () => {
  assert.equal(cleanEmail('me@example.com'), 'me@example.com');
  assert.equal(cleanEmail('me+akari@example.com'), 'me+akari@example.com');
  assert.equal(cleanEmail('first.last@mail.example.co.jp'), 'first.last@mail.example.co.jp');
  assert.equal(cleanEmail('  me@example.com\t\n'), 'me@example.com');
  const longest = 'a'.repeat(EMAIL_MAX_LENGTH - 'b@c.jp'.length + 1) + '@c.jp';
  assert.equal(longest.length, EMAIL_MAX_LENGTH);
  assert.equal(cleanEmail(longest), longest);
});

test('cleanEmail rejects non-strings, empty and malformed addresses', () => {
  for (const v of [undefined, null, 42, true, {}, ['me@example.com']]) assert.equal(cleanEmail(v), '', String(v));
  for (const v of ['', '   ', 'me', 'me@', '@example.com', 'me@@example.com', 'a@b@c.jp', 'me @example.com', 'me@exa mple.com']) {
    assert.equal(cleanEmail(v), '', JSON.stringify(v));
  }
});

test('cleanEmail rejects control, zero-width and bidi characters', () => {
  for (const ch of ['\u0000', '\u0007', '\u001b', '\u007f', '\u0085', '­', '​', '‍', '‎', '‮', '⁦', '⁩', '﻿']) {
    assert.equal(cleanEmail(`me${ch}@example.com`), '', 'U+' + ch.codePointAt(0).toString(16));
  }
});

test('cleanEmail rejects addresses over 254 characters', () => {
  const tooLong = 'a'.repeat(EMAIL_MAX_LENGTH - 'b@c.jp'.length + 2) + '@c.jp';
  assert.equal(tooLong.length, EMAIL_MAX_LENGTH + 1);
  assert.equal(cleanEmail(tooLong), '');
  assert.equal(cleanEmail('a'.repeat(1000) + '@c.jp'), '');
});
