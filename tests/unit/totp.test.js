import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Decode,
  base32Encode,
  normalizeSecret,
  isValidSecret,
  parseOtpauthUri,
  buildOtpauthUri,
  generateHotp,
  generateTotp,
  remainingSeconds,
} from '../../extension/src/lib/totp.js';
import { utf8, fromUtf8 } from '../../extension/src/shared/bytes.js';

// RFC 6238 Appendix B (8 digits). Seeds are ASCII strings of the length matching the hash.
const SEEDS = {
  SHA1: '12345678901234567890',
  SHA256: '12345678901234567890123456789012',
  SHA512: '1234567890123456789012345678901234567890123456789012345678901234',
};
const RFC6238 = [
  // [time (s), SHA1, SHA256, SHA512]
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];

test('RFC 6238 Appendix B test vectors (SHA1 / SHA256 / SHA512, 8 digits)', async () => {
  for (const [t, ...expected] of RFC6238) {
    for (const [i, algorithm] of ['SHA1', 'SHA256', 'SHA512'].entries()) {
      const config = { secret: base32Encode(utf8(SEEDS[algorithm])), algorithm, digits: 8, period: 30 };
      assert.equal(await generateTotp(config, t * 1000), expected[i], `${algorithm} @ T=${t}`);
    }
  }
});

test('RFC 4226 Appendix D HOTP vectors (6 digits)', async () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  const config = { secret: base32Encode(utf8(SEEDS.SHA1)), algorithm: 'SHA1', digits: 6 };
  for (let counter = 0; counter < expected.length; counter++) {
    assert.equal(await generateHotp(config, counter), expected[counter], `counter ${counter}`);
  }
});

test('generateTotp defaults to SHA1 / 6 digits / 30 s and zero-pads', async () => {
  const config = { secret: base32Encode(utf8(SEEDS.SHA1)) };
  // 6-digit truncation of the RFC T=59 value 94287082
  assert.equal(await generateTotp(config, 59000), '287082');
  // T=1111111109 → 07081804 → leading zero must survive in the 6-digit code
  assert.equal(await generateTotp(config, 1111111109000), '081804');
});

test('the code is stable inside a period and changes at the boundary', async () => {
  const config = { secret: 'JBSWY3DPEHPK3PXP', period: 30 };
  const a = await generateTotp(config, 30_000);
  assert.equal(await generateTotp(config, 59_999), a);
  assert.notEqual(await generateTotp(config, 60_000), a);
  const c60 = { ...config, period: 60 };
  assert.equal(await generateTotp(c60, 60_000), await generateTotp(c60, 119_999));
});

test('known secret JBSWY3DPEHPK3PXP produces the reference code', async () => {
  // "Hello!\xDE\xAD\xBE\xEF" – widely used demo secret; value cross-checked with node:crypto
  const { createHmac } = await import('node:crypto');
  const key = Buffer.from(base32Decode('JBSWY3DPEHPK3PXP'));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(1700000000 / 30)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const want = String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
  assert.equal(await generateTotp({ secret: 'JBSWY3DPEHPK3PXP' }, 1700000000 * 1000), want);
});

test('remainingSeconds', () => {
  const c = { period: 30 };
  assert.equal(remainingSeconds(c, 0), 30);
  assert.equal(remainingSeconds(c, 1000), 29);
  assert.equal(remainingSeconds(c, 29_999), 1);
  assert.equal(remainingSeconds(c, 30_000), 30);
  assert.equal(remainingSeconds({ period: 60 }, 61_000), 59);
  assert.equal(remainingSeconds({}, 1_000), 29); // default period
  const r = remainingSeconds(c);
  assert.ok(Number.isInteger(r) && r >= 1 && r <= 30);
});

test('base32 decode: case-insensitive, ignores spaces / hyphens / padding', () => {
  // RFC 4648 §10 test vectors
  const vectors = [['', ''], ['f', 'MY======'], ['fo', 'MZXQ===='], ['foo', 'MZXW6==='], ['foob', 'MZXW6YQ='], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI======']];
  for (const [plain, enc] of vectors) {
    assert.equal(fromUtf8(base32Decode(enc)), plain);
    assert.equal(fromUtf8(base32Decode(enc.toLowerCase())), plain);
    assert.equal(base32Encode(utf8(plain)), enc.replace(/=+$/, ''));
  }
  assert.equal(fromUtf8(base32Decode('mzxw 6ytb-oi')), 'foobar');
  assert.throws(() => base32Decode('MZXW1YTB'), /秘密鍵/); // '1' is not in the alphabet
});

test('base32 round-trips random bytes', () => {
  for (let n = 1; n <= 40; n++) {
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  }
});

test('normalizeSecret', () => {
  assert.equal(normalizeSecret('jbsw y3dp-ehpk 3pxp'), 'JBSWY3DPEHPK3PXP');
  assert.equal(normalizeSecret('  mzxw6ytb====\n'), 'MZXW6YTB');
  assert.equal(normalizeSecret(''), '');
  assert.equal(normalizeSecret(null), '');
});

test('isValidSecret', () => {
  assert.ok(isValidSecret('JBSWY3DPEHPK3PXP'));
  assert.ok(isValidSecret('jbsw y3dp ehpk 3pxp'));
  assert.ok(isValidSecret('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'));
  assert.ok(isValidSecret('MZXW6YTBOI======'));
  assert.ok(!isValidSecret(''));
  assert.ok(!isValidSecret('   '));
  assert.ok(!isValidSecret('JBSWY3D')); // too short
  assert.ok(!isValidSecret('JBSWY3DPEHPK3PX1')); // '1' invalid
  assert.ok(!isValidSecret('JBSWY3DPEHPK3PXP!'));
  assert.ok(!isValidSecret('JBSWY3DPEHPK3PXPA')); // 17 chars cannot encode whole bytes
  assert.ok(!isValidSecret(undefined));
});

test('parseOtpauthUri: standard Google Authenticator style URI', () => {
  const cfg = parseOtpauthUri('otpauth://totp/Example:alice@google.com?secret=JBSWY3DPEHPK3PXP&issuer=Example');
  assert.deepEqual(cfg, { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, issuer: 'Example', label: 'alice@google.com' });
});

test('parseOtpauthUri: URL-encoding and explicit parameters', () => {
  const cfg = parseOtpauthUri(
    'otpauth://totp/ACME%20Co:john.doe%40email.com?secret=hxdm vjec-jjws rb3h wizr 4ifu gftm xboz&issuer=ACME%20Co&algorithm=sha256&digits=8&period=60',
  );
  assert.deepEqual(cfg, {
    secret: 'HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ',
    algorithm: 'SHA256',
    digits: 8,
    period: 60,
    issuer: 'ACME Co',
    label: 'john.doe@email.com',
  });
});

test('parseOtpauthUri: issuer prefix only, no issuer parameter', () => {
  const cfg = parseOtpauthUri('otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP');
  assert.equal(cfg.issuer, 'GitHub');
  assert.equal(cfg.label, 'octocat');
});

test('parseOtpauthUri: issuer parameter wins over the label prefix', () => {
  const cfg = parseOtpauthUri('otpauth://totp/Old:me?secret=JBSWY3DPEHPK3PXP&issuer=New');
  assert.equal(cfg.issuer, 'New');
  assert.equal(cfg.label, 'me');
});

test('parseOtpauthUri: label without issuer, encoded colon, Japanese text, SHA512', () => {
  let cfg = parseOtpauthUri('otpauth://totp/me%40example.com?secret=JBSWY3DPEHPK3PXP&algorithm=SHA512');
  assert.equal(cfg.issuer, '');
  assert.equal(cfg.label, 'me@example.com');
  assert.equal(cfg.algorithm, 'SHA512');
  cfg = parseOtpauthUri('otpauth://totp/%E7%81%AF%3A%E3%83%A6%E3%83%BC%E3%82%B6%E3%83%BC?secret=JBSWY3DPEHPK3PXP');
  assert.equal(cfg.issuer, '灯');
  assert.equal(cfg.label, 'ユーザー');
  cfg = parseOtpauthUri('  otpauth://totp/?secret=JBSWY3DPEHPK3PXP  ');
  assert.equal(cfg.label, '');
});

test('parseOtpauthUri: rejects hotp, missing/invalid secret and bad parameters with Japanese messages', () => {
  const bad = [
    ['otpauth://hotp/Example:alice?secret=JBSWY3DPEHPK3PXP&counter=1', /HOTP/],
    ['otpauth://totp/Example:alice?issuer=Example', /secret/],
    ['otpauth://totp/Example:alice?secret=&issuer=Example', /secret/],
    ['otpauth://totp/Example:alice?secret=NOT*BASE32!', /秘密鍵/],
    ['otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=7', /桁数/],
    ['otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=0', /period/],
    ['otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=301', /period/],
    ['otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5', /アルゴリズム/],
    ['https://example.com/?secret=JBSWY3DPEHPK3PXP', /otpauth/],
    ['not a uri', /otpauth/],
    ['', /otpauth/],
  ];
  for (const [uri, re] of bad) {
    assert.throws(() => parseOtpauthUri(uri), (e) => e instanceof Error && re.test(e.message) && /[぀-ヿ一-鿿]/.test(e.message), uri);
  }
});

test('buildOtpauthUri round-trips through parseOtpauthUri', () => {
  const configs = [
    { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, issuer: 'Example', label: 'alice@example.com' },
    { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', algorithm: 'SHA256', digits: 8, period: 60, issuer: 'ACME Co & Sons', label: 'john doe/1' },
    { secret: 'MZXW6YTBOI', algorithm: 'SHA512', digits: 6, period: 30, issuer: '灯', label: 'ユーザー:1' },
    { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, issuer: '', label: 'only-label' },
  ];
  for (const cfg of configs) {
    const uri = buildOtpauthUri(cfg);
    assert.match(uri, /^otpauth:\/\/totp\//);
    assert.deepEqual(parseOtpauthUri(uri), cfg, uri);
  }
});

test('buildOtpauthUri applies defaults and normalizes the secret', () => {
  const uri = buildOtpauthUri({ secret: 'jbsw y3dp ehpk 3pxp', issuer: 'X', label: 'y' });
  assert.equal(uri, 'otpauth://totp/X:y?secret=JBSWY3DPEHPK3PXP&issuer=X&algorithm=SHA1&digits=6&period=30');
});
