import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePassword } from '../../extension/src/lib/generator.js';
import WORDS from '../../extension/src/lib/wordlist.js';

const SYMBOLS = '!@#$%^&*-_=+?';
const SEPS = '-_.!*#';

function chiSquare(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  const expected = total / counts.length;
  return counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
}

function many(n, opts) {
  return Array.from({ length: n }, () => generatePassword(opts));
}

test('wordlist: frozen, >= 1024 unique lowercase romaji words of 3-8 letters', () => {
  assert.ok(Array.isArray(WORDS));
  assert.ok(Object.isFrozen(WORDS));
  assert.ok(WORDS.length >= 1024, 'size ' + WORDS.length);
  assert.equal(new Set(WORDS).size, WORDS.length, 'duplicates found');
  for (const w of WORDS) {
    assert.match(w, /^[a-z]{3,8}$/, w);
  }
});

test('wordlist: contains the design words and no blocked words', () => {
  const design = 'sora kumo hoshi umi yama kaze hana mori tsuki yuki ame niji kawa hikari akari neko tori sakura kaede shiro aoi midori hotaru nami yoru asa tane michi'.split(' ');
  for (const w of design) assert.ok(WORDS.includes(w), w);
  const blocked = ['baka', 'kuso', 'shine', 'chikan', 'unko', 'manko', 'chinko', 'ero', 'hentai', 'aho', 'boke', 'kasu', 'debu', 'hage', 'kichigai', 'korosu', 'shinu', 'urusai', 'buta', 'iku', 'shabu', 'kayaku'];
  for (const w of blocked) assert.ok(!WORDS.includes(w), w);
  for (const w of WORDS) assert.doesNotMatch(w, /fuck|shit|cunt|dick|cock|pussy|whore|slut|nigg|rape|nazi|hitler/);
});

test('random: default is 20 chars from the four sets, bits = round(len * log2(pool))', () => {
  const { password, bits } = generatePassword();
  assert.equal(password.length, 20);
  assert.match(password, /^[A-Za-z0-9!@#$%^&*\-_=+?]{20}$/);
  assert.equal(bits, Math.round(20 * Math.log2(26 + 26 + 10 + SYMBOLS.length)));
  assert.equal(bits, 125);
});

test('random: exact length and at least one char from every enabled set (8..48)', () => {
  for (let length = 8; length <= 48; length++) {
    for (const { password } of many(40, { mode: 'random', length })) {
      assert.equal(password.length, length);
      assert.match(password, /[a-z]/);
      assert.match(password, /[A-Z]/);
      assert.match(password, /[0-9]/);
      assert.ok([...password].some((c) => SYMBOLS.includes(c)));
    }
  }
});

test('random: disabled sets never appear and bits follow the pool size', () => {
  for (const upper of [true, false]) {
    for (const digits of [true, false]) {
      for (const symbols of [true, false]) {
        const pool = 26 + (upper ? 26 : 0) + (digits ? 10 : 0) + (symbols ? SYMBOLS.length : 0);
        for (const { password, bits } of many(200, { length: 16, upper, digits, symbols })) {
          assert.equal(bits, Math.round(16 * Math.log2(pool)));
          assert.match(password, /[a-z]/);
          if (!upper) assert.doesNotMatch(password, /[A-Z]/);
          if (!digits) assert.doesNotMatch(password, /[0-9]/);
          if (!symbols) assert.ok(![...password].some((c) => SYMBOLS.includes(c)));
          if (upper) assert.match(password, /[A-Z]/);
          if (digits) assert.match(password, /[0-9]/);
          if (symbols) assert.ok([...password].some((c) => SYMBOLS.includes(c)));
        }
      }
    }
  }
});

test('random: avoidAmbiguous removes i l o I O 0 1 and shrinks the pool', () => {
  const batch = many(3000, { length: 24, avoidAmbiguous: true });
  for (const { password, bits } of batch) {
    assert.doesNotMatch(password, /[iloIO01]/);
    assert.equal(bits, Math.round(24 * Math.log2(23 + 24 + 8 + SYMBOLS.length)));
  }
  const plain = many(500, { length: 24 }).map((r) => r.password).join('');
  assert.match(plain, /[ilo]/);
  assert.match(plain, /[IO]/);
  assert.match(plain, /[01]/);
  const seen = new Set(batch.map((r) => r.password).join(''));
  for (const c of 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789') assert.ok(seen.has(c), c);
});

test('random: length is clamped to 8-48', () => {
  assert.equal(generatePassword({ length: 3 }).password.length, 8);
  assert.equal(generatePassword({ length: 100 }).password.length, 48);
  assert.equal(generatePassword({ length: 'x' }).password.length, 20);
  assert.equal(generatePassword({ length: 12.4 }).password.length, 12);
});

test('random: characters are uniformly distributed (chi-square)', () => {
  const counts = new Array(26).fill(0);
  for (const { password } of many(4000, { length: 48, upper: false, digits: false, symbols: false })) {
    for (const c of password) counts[c.charCodeAt(0) - 97]++;
  }
  assert.ok(chiSquare(counts) < 60, 'chi-square (df 25, 99.99th percentile about 52) ' + chiSquare(counts));
});

test('random: forced characters are shuffled to every position', () => {
  const counts = new Array(8).fill(0);
  for (const { password } of many(20000, { length: 8 })) {
    [...password].forEach((c, i) => { if (SYMBOLS.includes(c)) counts[i]++; });
  }
  assert.ok(chiSquare(counts) < 35, 'chi-square (df 7, 99.99th percentile about 26) ' + chiSquare(counts));
});

test('random: passwords are not repeated', () => {
  const set = new Set(many(500, { length: 12 }).map((r) => r.password));
  assert.equal(set.size, 500);
});

test('uses crypto.getRandomValues and never Math.random', () => {
  const realRandom = Math.random;
  const realGrv = crypto.getRandomValues;
  let calls = 0;
  Math.random = () => { throw new Error('Math.random must not be used'); };
  crypto.getRandomValues = function (arr) { calls++; return realGrv.call(crypto, arr); };
  try {
    generatePassword({ mode: 'random', length: 20 });
    generatePassword({ mode: 'phrase', words: 4 });
  } finally {
    Math.random = realRandom;
    delete crypto.getRandomValues;
  }
  assert.ok(calls > 0);
  assert.equal(crypto.getRandomValues, realGrv);
});

test('phrase: default is 4 capitalised words, per-gap separators and a 2-digit number', () => {
  const { password, bits } = generatePassword({ mode: 'phrase' });
  assert.match(password, /^[A-Z][a-z]+(?:[-_.!*#][A-Z][a-z]+){3}[-_.!*#][1-9]\d$/);
  const words = password.split(/[-_.!*#]/);
  assert.equal(words.length, 5);
  for (const w of words.slice(0, 4)) assert.ok(WORDS.includes(w.toLowerCase()), w);
  assert.ok(Number(words[4]) >= 10 && Number(words[4]) <= 99);
  const expected = 4 * Math.log2(WORDS.length) + 4 * Math.log2(6) + Math.log2(90);
  assert.equal(bits, Math.round(expected));
});

test('phrase: word count 3-8 (clamped) and bits scale with it', () => {
  for (let words = 3; words <= 8; words++) {
    const { password, bits } = generatePassword({ mode: 'phrase', words, upper: false, digits: false, symbols: false });
    assert.match(password, new RegExp('^[a-z]+(?:-[a-z]+){' + (words - 1) + '}$'));
    assert.equal(bits, Math.round(words * Math.log2(WORDS.length)));
  }
  assert.equal(generatePassword({ mode: 'phrase', words: 1, digits: false }).password.split(/[-_.!*#]/).length, 3);
  assert.equal(generatePassword({ mode: 'phrase', words: 99, digits: false }).password.split(/[-_.!*#]/).length, 8);
});

test('phrase: option flags', () => {
  for (const { password } of many(300, { mode: 'phrase', upper: false })) assert.doesNotMatch(password, /[A-Z]/);
  for (const { password } of many(300, { mode: 'phrase', symbols: false })) {
    assert.match(password, /^[A-Z][a-z]+(?:-[A-Z][a-z]+){3}-\d{2}$/);
  }
  for (const { password } of many(300, { mode: 'phrase', digits: false })) assert.doesNotMatch(password, /\d/);
  const noSym = generatePassword({ mode: 'phrase', symbols: false, digits: true });
  assert.equal(noSym.bits, Math.round(4 * Math.log2(WORDS.length) + Math.log2(90)));
  const digitsOnly = generatePassword({ mode: 'phrase', upper: false, symbols: true, digits: false });
  assert.equal(digitsOnly.bits, Math.round(4 * Math.log2(WORDS.length) + 3 * Math.log2(6)));
});

test('phrase: every separator and a wide spread of words are produced', () => {
  const seen = new Set();
  const buckets = new Array(8).fill(0);
  for (const { password } of many(4000, { mode: 'phrase', words: 4 })) {
    for (const c of password) if (SEPS.includes(c)) seen.add(c);
    for (const w of password.split(/[-_.!*#]/).slice(0, 4)) {
      buckets[Math.floor((WORDS.indexOf(w.toLowerCase()) / WORDS.length) * 8)]++;
    }
  }
  assert.deepEqual([...seen].sort(), [...SEPS].sort());
  assert.ok(chiSquare(buckets) < 35, 'chi-square ' + chiSquare(buckets));
});

test('unknown mode is rejected', () => {
  assert.throws(() => generatePassword({ mode: 'pin' }), RangeError);
});
