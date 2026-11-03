import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decryptPgp, encryptPgp } from '../../extension/src/lib/pgp.js';
import { ImportError, isPgp } from '../../extension/src/lib/import/model.js';
import * as openpgp from '../../extension/src/third_party/openpgp.js';
import { fromB64 } from '../../extension/src/shared/bytes.js';

const te = new TextEncoder();
const td = new TextDecoder();
const armorBytes = (s) => te.encode(s);

// Made with GnuPG 2.4.7: `gpg --symmetric [--cipher-algo AES256 --armor | --force-ocb --armor]`,
// passphrase "gnupg-pass", plaintext GPG_PLAIN. SKESK v4 without session-key packet,
// ZIP-compressed literal data, old-format packet headers.
const GPG_PASS = 'gnupg-pass';
const GPG_PLAIN = 'from,gnupg\r\nテスト,1\r\n';
const GPG_ARMORED = `-----BEGIN PGP MESSAGE-----

jA0ECQMIxAMoVCotbrjw0lgBfqi3+m9drUIu2Knilk4qIc67HoorMeFu+pW5mBci
OZriAa57aYG4Co/leM6d1GeySmBXSfhdQMrswN9/+ndTRe14rvdEFNZIKnnnF6DK
RsTfV27obrj9
=Auuc
-----END PGP MESSAGE-----
`;
const GPG_BINARY_B64 = 'jA0ECQMIfb/DXbUz5mzw0lgBs+drvgAJeCa0CfhnHraXjYPsYYPGnqXDMjbUuTUvhnyInACKvhpMuNR5l3aTttw/lj3a82C4RSatbHVY+7HvUbry9hz+2Xo/gZRVupdmFmAl/QozwgCh';
// GnuPG's LibrePGP AEAD (OCB, SKESK v5 + AEAD packet).
const GPG_OCB = `-----BEGIN PGP MESSAGE-----

jE0FCQIDCA/NYHDxoJa38C02LJ61jGG+7HRtUKYPqIE2Aje+vDWFXzGO7ks79cI4
ihX4BHWrfb+8sa4lAC/aZlqEMBFGIjcR1XQJGpZEOtRiAQkCEILHUOavd1bwCJQC
Ukp9Ui7sX8heYBELKq2w27iqNXaGynb5xmtKlZywm+mqZmlvvXSc0QCkFwkTCpEt
whW/ib9NjLkT99XAHgqF+pNsK5YcPHSVa9uAYR11mc1g0iA=
=uQJm
-----END PGP MESSAGE-----
`;

const rejectsWith = (p, code) => assert.rejects(p, (e) => e instanceof ImportError && e.code === code && /[ぁ-んァ-ン一-龠]/.test(e.message));

test('encryptPgp → decryptPgp round-trip (string and bytes), armored output', async () => {
  const text = 'name,url,username,password\r\n日本語,https://例え.jp,ユーザー,p@ss "q"\r\n';
  const armored = await encryptPgp(text, 'passphrase-1', { filename: 'akari-export.csv' });
  assert.match(armored, /^-----BEGIN PGP MESSAGE-----\n/);
  assert.match(armored, /-----END PGP MESSAGE-----\s*$/);
  assert.ok(!armored.includes('akari'), 'nothing in clear');
  assert.equal(td.decode(await decryptPgp(armorBytes(armored), 'passphrase-1')), text, 'byte-exact (CRLF kept)');

  const bytes = Uint8Array.from({ length: 3000 }, (_, i) => (i * 37) & 0xff);
  const out = await decryptPgp(armorBytes(await encryptPgp(bytes, 'pw')), 'pw');
  assert.ok(out instanceof Uint8Array);
  assert.deepEqual(out, bytes);
});

test('written messages use GnuPG-2.2-compatible packets: SKESK v4 + SEIPD v1, AES-256, iterated S2K', async () => {
  const armored = await encryptPgp('x', 'pw', { filename: 'f.json' });
  const msg = await openpgp.readMessage({ armoredMessage: armored });
  const [skesk, seipd, ...rest] = msg.packets;
  assert.equal(rest.length, 0);
  assert.ok(skesk instanceof openpgp.SymEncryptedSessionKeyPacket);
  assert.equal(skesk.version, 4);
  assert.equal(skesk.sessionKeyEncryptionAlgorithm, openpgp.enums.symmetric.aes256);
  assert.equal(skesk.s2k.type, 'iterated');
  assert.equal(skesk.s2k.algorithm, openpgp.enums.hash.sha256);
  assert.ok(seipd instanceof openpgp.SymEncryptedIntegrityProtectedDataPacket);
  assert.equal(seipd.version, 1);
  const [sessionKey] = await openpgp.decryptSessionKeys({ message: msg, passwords: ['pw'] });
  assert.equal(sessionKey.algorithm, 'aes256');
  const { data, filename } = await openpgp.decrypt({ message: msg, passwords: ['pw'], format: 'binary' });
  assert.equal(td.decode(data), 'x');
  assert.equal(filename, 'f.json');
  assert.ok(isPgp(armorBytes(armored)), 'model.isPgp recognizes the output');
});

test('wrong passphrase → BAD_PASSWORD; empty → NEEDS_PASSWORD', async () => {
  const armored = await encryptPgp('secret', 'right-pass');
  await assert.rejects(decryptPgp(armorBytes(armored), 'wrong-pass'), { name: 'ImportError', code: 'BAD_PASSWORD', message: 'パスフレーズが違うか、ファイルが壊れています' });
  await rejectsWith(decryptPgp(armorBytes(armored), ''), 'NEEDS_PASSWORD');
  await assert.rejects(decryptPgp(armorBytes(GPG_ARMORED), 'nope'), { code: 'BAD_PASSWORD' });
  await assert.rejects(decryptPgp(fromB64(GPG_BINARY_B64), 'nope'), { code: 'BAD_PASSWORD' });
  await assert.rejects(decryptPgp(armorBytes(GPG_OCB), 'nope'), { code: 'BAD_PASSWORD' });
});

test('binary and armored input', async () => {
  const armored = await encryptPgp('both forms', 'pw');
  const binary = (await openpgp.unarmor(armored)).data;
  assert.ok(binary instanceof Uint8Array && binary.length > 20);
  assert.ok(isPgp(binary));
  assert.equal(td.decode(await decryptPgp(binary, 'pw')), 'both forms');
  // Armor after leading whitespace / a BOM-less preamble line still counts as armored.
  assert.equal(td.decode(await decryptPgp(armorBytes('\r\n' + armored.replace(/\n/g, '\r\n')), 'pw')), 'both forms');
});

test('decrypts real GnuPG 2.4 output: armored AES-256, binary default, OCB AEAD', async () => {
  assert.equal(td.decode(await decryptPgp(armorBytes(GPG_ARMORED), GPG_PASS)), GPG_PLAIN);
  const bin = fromB64(GPG_BINARY_B64);
  assert.ok(isPgp(bin), 'old-format SKESK header recognized');
  assert.equal(td.decode(await decryptPgp(bin, GPG_PASS)), GPG_PLAIN);
  assert.equal(td.decode(await decryptPgp(armorBytes(GPG_OCB), GPG_PASS)), GPG_PLAIN);
});

test('decrypts OpenPGP.js messages with GnuPG-compatible settings and with AEAD (SEIPD v2)', async () => {
  for (const config of [
    { aeadProtect: false, preferredCompressionAlgorithm: openpgp.enums.compression.zlib },
    { aeadProtect: true },
    { aeadProtect: true, preferredAEADAlgorithm: openpgp.enums.aead.ocb },
  ]) {
    const armored = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'proton,pass\n' }), passwords: ['pp-1'], config,
    });
    const msg = await openpgp.readMessage({ armoredMessage: armored });
    const seipd = msg.packets.find((p) => p instanceof openpgp.SymEncryptedIntegrityProtectedDataPacket);
    assert.equal(seipd.version, config.aeadProtect ? 2 : 1);
    // Text-mode literal data comes back in its canonical CRLF form.
    assert.equal(td.decode(await decryptPgp(armorBytes(armored), 'pp-1')), 'proton,pass\r\n', JSON.stringify(config));
    await assert.rejects(decryptPgp(armorBytes(armored), 'pp-2'), { code: 'BAD_PASSWORD' });
  }
});

test('public-key encrypted → UNSUPPORTED; garbage → INVALID_FORMAT; signed-only → INVALID_FORMAT', async () => {
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ name: 'Test', email: 'test@example.com' }], format: 'object',
  });
  const pk = await openpgp.encrypt({ message: await openpgp.createMessage({ text: 'x' }), encryptionKeys: publicKey });
  await rejectsWith(decryptPgp(armorBytes(pk), 'anything'), 'UNSUPPORTED');
  const pkBinary = (await openpgp.unarmor(pk)).data;
  await rejectsWith(decryptPgp(pkBinary, 'anything'), 'UNSUPPORTED');

  // Both a key and a passphrase (gpg -c -e): the passphrase path works.
  const both = await openpgp.encrypt({ message: await openpgp.createMessage({ text: 'y' }), encryptionKeys: publicKey, passwords: ['pw'] });
  assert.equal(td.decode(await decryptPgp(armorBytes(both), 'pw')), 'y');

  await rejectsWith(decryptPgp(te.encode('-----BEGIN PGP MESSAGE-----\n\nnot base64!!\n-----END PGP MESSAGE-----\n'), 'pw'), 'INVALID_FORMAT');
  await rejectsWith(decryptPgp(Uint8Array.of(0xc3, 0x01, 0xff, 0x00), 'pw'), 'INVALID_FORMAT');

  const signed = await openpgp.sign({ message: await openpgp.createMessage({ text: 'z' }), signingKeys: privateKey });
  await rejectsWith(decryptPgp(armorBytes(signed), 'pw'), 'INVALID_FORMAT');
});

test('encryptPgp argument checks', async () => {
  await assert.rejects(encryptPgp('x', ''), TypeError);
  await assert.rejects(encryptPgp({}, 'pw'), TypeError);
  await assert.rejects(decryptPgp('string', 'pw'), TypeError);
});

test('Argon2 S2K: decrypts where WebAssembly runs; UNSUPPORTED (not BAD_PASSWORD) where it is blocked', async () => {
  const armored = await openpgp.encrypt({
    message: await openpgp.createMessage({ binary: te.encode('argon') }),
    passwords: ['pw'],
    config: { s2kType: openpgp.enums.s2k.argon2, s2kArgon2Params: { passes: 1, parallelism: 1, memoryExponent: 10 } },
  });
  assert.equal(td.decode(await decryptPgp(armorBytes(armored), 'pw')), 'argon');
  const original = WebAssembly.compile;
  WebAssembly.compile = () => Promise.reject(new WebAssembly.CompileError('blocked by CSP'));
  try {
    await rejectsWith(decryptPgp(armorBytes(armored), 'pw'), 'UNSUPPORTED');
  } finally {
    WebAssembly.compile = original;
  }
});

// ---- limits on cost parameters taken from the file ---------------------------------

const ARGON2 = (params) => ({ s2kType: openpgp.enums.s2k.argon2, s2kArgon2Params: params });

test('more than 4 passphrase packets (SKESK) → UNSUPPORTED before any S2K runs', async () => {
  const four = await openpgp.encrypt({ message: await openpgp.createMessage({ text: 'x' }), passwords: ['a', 'b', 'c', 'd'] });
  assert.equal(td.decode(await decryptPgp(armorBytes(four), 'd')), 'x');
  const five = await openpgp.encrypt({ message: await openpgp.createMessage({ text: 'x' }), passwords: ['a', 'b', 'c', 'd', 'e'] });
  assert.equal((await openpgp.readMessage({ armoredMessage: five })).packets.filter((p) => p instanceof openpgp.SymEncryptedSessionKeyPacket).length, 5);
  await rejectsWith(decryptPgp(armorBytes(five), 'a'), 'UNSUPPORTED');
});

test('Argon2 parameters above passes 10 / parallelism 16 / memory 2^20 KiB → UNSUPPORTED; Proton defaults decrypt', async () => {
  // OpenPGP.js / Proton Pass defaults: t=3, p=4, m=2^16 KiB (64 MiB).
  const proton = await openpgp.encrypt({
    message: await openpgp.createMessage({ binary: te.encode('proton') }), passwords: ['pw'],
    config: ARGON2({ passes: 3, parallelism: 4, memoryExponent: 16 }),
  });
  assert.equal(td.decode(await decryptPgp(armorBytes(proton), 'pw')), 'proton');

  // Raise parameters in the packet without running them (encrypting at m=2^21 would need 2 GiB).
  const small = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: 'x' }), passwords: ['pw'], format: 'binary',
    config: ARGON2({ passes: 1, parallelism: 1, memoryExponent: 10 }),
  });
  // SKESK v4: header(2) version algo s2k-type=4 salt(16) t p encodedM …
  assert.deepEqual([small[0], small[2], small[4], small[21], small[22], small[23]], [0xc3, 4, 4, 1, 1, 10]);
  const tweak = ({ t = 1, p = 1, encodedM = 10 }) => {
    const b = small.slice();
    b.set([t, p, encodedM], 21);
    return b;
  };
  // (RFC 9580 needs memory >= 2^(3 + ceil(log2 p)) KiB, hence encodedM 11 with p = 255.)
  for (const params of [{ t: 11 }, { t: 255 }, { p: 17 }, { p: 255, encodedM: 11 }, { encodedM: 21 }, { encodedM: 30 }]) {
    const t0 = Date.now();
    await rejectsWith(decryptPgp(tweak(params), 'pw'), 'UNSUPPORTED');
    assert.ok(Date.now() - t0 < 1000, JSON.stringify(params) + ' refused before running Argon2');
  }
  // At the limits the packet is accepted (the changed parameters just don't open it).
  await assert.rejects(decryptPgp(tweak({ t: 10, p: 16 }), 'pw'), { code: 'BAD_PASSWORD' });
});

test('Argon2 out of memory → UNSUPPORTED, not BAD_PASSWORD', async () => {
  const armored = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: 'x' }), passwords: ['pw'], config: ARGON2({ passes: 1, parallelism: 1, memoryExponent: 18 }),
  });
  const grow = WebAssembly.Memory.prototype.grow;
  WebAssembly.Memory.prototype.grow = () => { throw new RangeError('WebAssembly.Memory.grow(): Maximum memory size exceeded'); };
  try {
    await rejectsWith(decryptPgp(armorBytes(armored), 'pw'), 'UNSUPPORTED');
  } finally {
    WebAssembly.Memory.prototype.grow = grow;
  }
  assert.equal(td.decode(await decryptPgp(armorBytes(armored), 'pw')), 'x');
});

test('decompressed output is capped at 64 MiB (zlib and zip bombs → UNSUPPORTED)', async () => {
  const bomb = new Uint8Array(64 * 2 ** 20 + 1);
  for (const algo of ['zlib', 'zip']) {
    const binary = await openpgp.encrypt({
      message: await openpgp.createMessage({ binary: bomb }), passwords: ['pw'], format: 'binary',
      config: { preferredCompressionAlgorithm: openpgp.enums.compression[algo] },
    });
    assert.ok(binary.length < 200 * 1024, `${algo}: ${binary.length} bytes on disk`);
    await assert.rejects(decryptPgp(binary, 'pw'), { code: 'UNSUPPORTED', message: 'ファイルが大きすぎます（展開後 64 MB まで）' });
  }
  const fine = await openpgp.encrypt({
    message: await openpgp.createMessage({ binary: new Uint8Array(8 * 2 ** 20).fill(7) }), passwords: ['pw'], format: 'binary',
    config: { preferredCompressionAlgorithm: openpgp.enums.compression.zlib },
  });
  assert.equal((await decryptPgp(fine, 'pw')).length, 8 * 2 ** 20);
});

test('a damaged message reads as "wrong passphrase or damaged file"', async () => {
  const binary = (await openpgp.unarmor(await encryptPgp('some data to damage', 'pw'))).data;
  binary[binary.length - 5] ^= 0xff;
  await assert.rejects(decryptPgp(binary, 'pw'), { code: 'BAD_PASSWORD', message: 'パスフレーズが違うか、ファイルが壊れています' });
});
