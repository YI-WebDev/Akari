import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateStrength } from '../../extension/src/lib/strength.js';
import { generatePassword } from '../../extension/src/lib/generator.js';
import WORDS from '../../extension/src/lib/wordlist.js';

const LABELS = { 0: '—', 1: '弱い', 2: '普通', 3: '強い', 4: '非常に強い' };

test('empty or non-string input scores level 0', () => {
  assert.deepEqual(estimateStrength(''), { bits: 0, level: 0, label: '—' });
  assert.deepEqual(estimateStrength(undefined), { bits: 0, level: 0, label: '—' });
  assert.deepEqual(estimateStrength(null), { bits: 0, level: 0, label: '—' });
});

test('result shape: label always matches level', () => {
  for (const pw of ['a', 'abc', 'hunter2', 'xkqjzvwbmt', 'k7#Qm2$vXz9!pLw4', 'ひらがな']) {
    const r = estimateStrength(pw);
    assert.ok(Number.isInteger(r.bits) && r.bits >= 1);
    assert.ok(r.level >= 1 && r.level <= 4);
    assert.equal(r.label, LABELS[r.level]);
  }
});

test('thresholds follow the design: <40 弱い, <64 普通, <88 強い, else 非常に強い', () => {
  // random-looking lowercase letters: 26-letter pool => 4.7 bits per character
  const cases = [
    ['xkqjzvwb', 1], // 8  chars, 38 bits
    ['xkqjzvwbmt', 2], // 10 chars, 47 bits
    ['qpzmxnwkbvrt', 2], // 12 chars, 56 bits
    ['qpzmxnwkbvrtjg', 3], // 14 chars, 66 bits
    ['qpzmxnwkbvrtjgdy', 3], // 16 chars, 75 bits
    ['qpzmxnwkbvrtjgdyhfc', 4], // 19 chars, 89 bits
  ];
  for (const [pw, level] of cases) {
    const r = estimateStrength(pw);
    assert.equal(r.level, level, `${pw}: ${r.bits} bits`);
  }
  assert.equal(estimateStrength('xkqjzvwb').bits, Math.round(8 * Math.log2(26)));
});

test('never exceeds the plain charset-pool estimate', () => {
  for (const pw of ['Tr0ub4dor&3', 'k7#Qm2$vXz9!pLw4', 'sora-kumo-hana', 'Summer2024!', 'abcabcabc', '漢字かな交じり文']) {
    const pool = (/[a-z]/.test(pw) ? 26 : 0) + (/[A-Z]/.test(pw) ? 26 : 0) + (/\d/.test(pw) ? 10 : 0) + (/[^A-Za-z0-9]/.test(pw) ? 132 : 0);
    assert.ok(estimateStrength(pw).bits <= Math.round(pw.length * Math.log2(pool)), pw);
  }
});

test('very common passwords are 弱い, including capitalised and leetspeak variants', () => {
  const weak = [
    'password', 'Password', 'PASSWORD', 'password1', 'Password123', 'p@ssw0rd', 'P@ssw0rd!', 'Passw0rd2024',
    '123456', '12345678', '123456789', '1234567890', '111111', '000000', '654321',
    'qwerty', 'qwerty123', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1q2w3e4r', '1qaz2wsx',
    'iloveyou', 'ILoveYou!', 'letmein', 'welcome1', 'admin123', 'dragon', 'monkey', 'sunshine',
    'abc123', 'sakura', 'sakura2020', 'daisuki', 'hikari', 'tanaka1985', 'naruto',
  ];
  for (const pw of weak) {
    const r = estimateStrength(pw);
    assert.equal(r.level, 1, `${pw}: ${r.bits} bits, level ${r.level}`);
    assert.equal(r.label, '弱い');
  }
});

test('sequences, repeats, years and word+digits shapes are 弱い', () => {
  const weak = [
    'abcdefgh', 'abcdefghijkl', 'ZYXWVUTSRQ', 'mnopqrstuvwx', '987654321012', '13572468', // runs
    'aaaaaaaaaaaa', '!!!!!!!!!!!!', 'abababababab', '123123123123', 'xyzxyzxyzxyz', 'passwordpassword', // repeats
    'Summer2024!', 'Sunflower2024', 'Tanaka1985!', 'MyDog1999', 'hello1990', 'sunrise2001', // word + year / digits
    '19900101', '20240101', '19851225', // dates
    'aaa111bbb222', 'qazwsxedcrfv',
  ];
  for (const pw of weak) {
    const r = estimateStrength(pw);
    assert.equal(r.level, 1, `${pw}: ${r.bits} bits, level ${r.level}`);
  }
});

test('the design cap: letters followed by digits under 14 chars is at most 28 bits', () => {
  assert.ok(estimateStrength('Xkqjzvwb12').bits <= 28);
  assert.ok(estimateStrength('qjzxkwmvbtpl7').bits <= 28);
  // 14+ chars is not capped
  assert.ok(estimateStrength('qjzxkwmvbtplhd7').bits > 28);
});

test('genuinely random passwords are 強い or better and score higher with more length', () => {
  for (const pw of ['k7#Qm2$vXz9!pLw4', 'Zb4!uQ8@mVx2#nTe', 'p9Lw$3Hq&7Nd!2Ks5Fc']) {
    assert.equal(estimateStrength(pw).level, 4, pw);
  }
  assert.ok(estimateStrength('k7#Qm2$vXz9!pLw4').bits > estimateStrength('k7#Qm2$vXz9').bits);
  assert.ok(estimateStrength('k7#Qm2$vXz9').bits > estimateStrength('k7#Qm2$v').bits);
});

test('word passphrases are scored by word count, not by character pool', () => {
  const wordBits = Math.log2(WORDS.length);
  const sep = (n) => 3 * n; // estimator charges ~3 bits per separator
  const five = ['sora', 'kumo', 'hana', 'neko', 'tori'].join('-');
  const r5 = estimateStrength(five);
  // 5 words + 4 separators, far below the ~170 bits the character pool would imply
  assert.ok(r5.bits >= 5 * wordBits - 1 && r5.bits <= 5 * wordBits + sep(4) + 1, `${five}: ${r5.bits}`);
  assert.ok(r5.bits < 80);
  // capitalised words cost a little more than lowercase ones, never less
  const capped = estimateStrength('Sora-Kumo-Hana-Neko-Tori');
  assert.ok(capped.bits >= r5.bits);
  // more words => stronger
  const bits = [2, 3, 4, 5, 6].map((n) => estimateStrength(['sora', 'umi', 'yama', 'kaze', 'hoshi', 'tsuki'].slice(0, n).join('-')).bits);
  for (let i = 1; i < bits.length; i++) assert.ok(bits[i] > bits[i - 1], bits.join(','));
  assert.equal(estimateStrength('sora-kumo').level, 1);
  assert.equal(estimateStrength('sora-kumo-hana-neko-tori-yuki').level >= 3, true);
});

test('generator output scores close to the generator\'s own entropy figure', () => {
  const random = Array.from({ length: 300 }, () => generatePassword({ mode: 'random', length: 20 }));
  for (const { password } of random) assert.equal(estimateStrength(password).level, 4, password);

  for (const length of [12, 16, 24, 32]) {
    for (let i = 0; i < 100; i++) {
      const { password, bits } = generatePassword({ mode: 'random', length });
      // the estimator uses a 94-symbol pool, so it may sit a few bits above; coincidental patterns pull it down
      assert.ok(estimateStrength(password).bits <= bits + 12, password);
    }
  }
  for (const words of [3, 4, 5, 6, 8]) {
    const diffs = [];
    for (let i = 0; i < 100; i++) {
      const { password, bits } = generatePassword({ mode: 'phrase', words });
      diffs.push(estimateStrength(password).bits - bits);
    }
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    assert.ok(Math.abs(mean) <= 14, `words=${words} mean diff ${mean}`);
  }
  // default phrase: 4 words + digits is 普通 or better
  for (let i = 0; i < 100; i++) assert.ok(estimateStrength(generatePassword({ mode: 'phrase' }).password).level >= 2);
});

test('is deterministic', () => {
  for (const pw of ['Tr0ub4dor&3', 'sora-kumo-hana', 'k7#Qm2$vXz9!pLw4']) {
    assert.deepEqual(estimateStrength(pw), estimateStrength(pw));
  }
});

test('handles unusual input quickly', () => {
  const inputs = ['a'.repeat(5000), 'ab'.repeat(2000), '1234567890'.repeat(300), ' '.repeat(40), '😀😀😀😀', 'ひらがなだけのぱすわーど', '\u0000\t\n'];
  const t0 = performance.now();
  for (const pw of inputs) {
    const r = estimateStrength(pw);
    assert.ok(r.bits >= 1 && r.level >= 1 && r.level <= 4, JSON.stringify(pw.slice(0, 8)));
  }
  assert.ok(performance.now() - t0 < 500, 'took ' + (performance.now() - t0));
});

test('fast: well under 1 ms per typical password', () => {
  const pws = Array.from({ length: 500 }, (_, i) => generatePassword({ mode: i % 2 ? 'phrase' : 'random', length: 24 }).password);
  estimateStrength(pws[0]); // warm up
  const t0 = performance.now();
  for (const pw of pws) estimateStrength(pw);
  const per = (performance.now() - t0) / pws.length;
  assert.ok(per < 1, per.toFixed(3) + ' ms per call');
});
