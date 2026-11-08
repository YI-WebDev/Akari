import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, decodePartial } from '../../extension/src/lib/cbor.js';

const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (h) => new Uint8Array(Buffer.from(h, 'hex'));

const VECTORS = [
  [0, '00'], [1, '01'], [10, '0a'], [23, '17'], [24, '1818'], [25, '1819'], [100, '1864'],
  [1000, '1903e8'], [1000000, '1a000f4240'], [1000000000000, '1b000000e8d4a51000'],
  [-1, '20'], [-10, '29'], [-100, '3863'], [-1000, '3903e7'],
  ['', '60'], ['a', '6161'], ['IETF', '6449455446'], ['"\\', '62225c'], ['ü', '62c3bc'], ['水', '63e6b0b4'],
  [false, 'f4'], [true, 'f5'], [null, 'f6'],
  [[], '80'], [[1, 2, 3], '83010203'], [[1, [2, 3], [4, 5]], '8301820203820405'],
];

test('RFC 8949 vectors encode and decode', () => {
  for (const [value, h] of VECTORS) {
    assert.equal(hex(encode(value)), h, 'encode ' + JSON.stringify(value));
    assert.deepEqual(decode(unhex(h)), value, 'decode ' + h);
  }
});

test('byte strings round-trip as Uint8Array', () => {
  assert.equal(hex(encode(new Uint8Array(0))), '40');
  assert.equal(hex(encode(Uint8Array.of(1, 2, 3, 4))), '4401020304');
  assert.equal(hex(encode(Uint8Array.of(1, 2).buffer)), '420102');
  const big = new Uint8Array(300).fill(7);
  const enc = encode(big);
  assert.equal(hex(enc.subarray(0, 3)), '59012c');
  assert.deepEqual(decode(enc), big);
});

test('maps use CTAP2 canonical key order', () => {
  const coseEc2Key = new Map([[-3, 1], [-2, 2], [-1, 1], [3, -7], [1, 2]]);
  assert.equal(hex(encode(coseEc2Key)), 'a5' + '0102' + '0326' + '2001' + '2102' + '2201');
  const attestationObject = encode({ authData: new Uint8Array(0), attStmt: {}, fmt: 'none' });
  assert.equal(hex(attestationObject), 'a3' + '63666d74' + '646e6f6e65' + '6761747453746d74' + 'a0' + '686175746844617461' + '40');
  assert.equal(hex(encode(new Map([['a', 1], [1, 2]]))), 'a2' + '0102' + '616101', 'Integers sort before strings');
});

test('decoded maps are Map instances', () => {
  const m = decode(unhex('a201020304'));
  assert.ok(m instanceof Map);
  assert.equal(m.get(1), 2);
  assert.equal(m.get(3), 4);
  const obj = decode(encode({ fmt: 'none', attStmt: {} }));
  assert.equal(obj.get('fmt'), 'none');
  assert.equal(obj.get('attStmt').size, 0);
});

test('decodePartial reports the end offset', () => {
  const bytes = unhex('a10102' + 'ff');
  const { value, offset } = decodePartial(bytes, 0);
  assert.equal(value.get(1), 2);
  assert.equal(offset, 3);
});

test('decoder rejects malformed input', () => {
  assert.throws(() => decode(unhex('0001')), /trailing/);
  assert.throws(() => decode(unhex('19')), /truncated/);
  assert.throws(() => decode(unhex('4501')), /truncated/);
  assert.throws(() => decode(unhex('9fff')), /unsupported/, 'indefinite length');
  assert.throws(() => decode(unhex('c0')), /tags/);
  assert.throws(() => decode(unhex('fa47c35000')), /unsupported/, 'float');
  assert.throws(() => decode(unhex('a2010201 03'.replace(' ', ''))), /duplicate/);
  assert.throws(() => decode(unhex('9a7fffffff')), /truncated/);
});

test('encoder rejects unsupported values', () => {
  assert.throws(() => encode(1.5), TypeError);
  assert.throws(() => encode(undefined), TypeError);
  assert.throws(() => encode(new Map([[1, 1], [1.5, 2]])), TypeError);
});
