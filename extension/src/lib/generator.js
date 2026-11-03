// Password generator. Every random choice goes through randomInt (rejection sampling, no modulo bias).
import { randomInt } from '../shared/bytes.js';
import WORDS from './wordlist.js';

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SYMBOLS = '!@#$%^&*-_=+?';
const PHRASE_SEPARATORS = '-_.!*#';

const clampInt = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const pick = (chars) => chars[randomInt(chars.length)];

/**
 * @param {object} [opts]
 * @param {'random'|'phrase'} [opts.mode]
 * @param {number} [opts.length] random mode, 8-48
 * @param {number} [opts.words] phrase mode, 3-8
 * @returns {{ password: string, bits: number }} bits = entropy of the construction, rounded
 */
export function generatePassword({
  mode = 'random',
  length = 20,
  words = 4,
  upper = true,
  digits = true,
  symbols = true,
  avoidAmbiguous = false,
} = {}) {
  if (mode === 'phrase') return generatePhrase({ words: clampInt(words, 3, 8, 4), upper, digits, symbols });
  if (mode !== 'random') throw new RangeError('generatePassword: unknown mode ' + mode);
  return generateRandom({ length: clampInt(length, 8, 48, 20), upper, digits, symbols, avoidAmbiguous });
}

function generateRandom({ length, upper, digits, symbols, avoidAmbiguous }) {
  let lo = LOWER;
  let up = UPPER;
  let dg = DIGITS;
  if (avoidAmbiguous) {
    lo = lo.replace(/[ilo]/g, '');
    up = up.replace(/[IO]/g, '');
    dg = dg.replace(/[01]/g, '');
  }
  const sets = [lo];
  if (upper) sets.push(up);
  if (digits) sets.push(dg);
  if (symbols) sets.push(SYMBOLS);
  const all = sets.join('');

  // One character from every enabled set, the rest from the union, then Fisher-Yates.
  const chars = sets.map(pick);
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return { password: chars.join(''), bits: Math.round(length * Math.log2(all.length)) };
}

function generatePhrase({ words, upper, digits, symbols }) {
  const seps = symbols ? PHRASE_SEPARATORS : '-';
  const parts = [];
  for (let i = 0; i < words; i++) {
    const w = WORDS[randomInt(WORDS.length)];
    parts.push(upper ? w[0].toUpperCase() + w.slice(1) : w);
  }
  let password = parts[0];
  for (let i = 1; i < parts.length; i++) password += pick(seps) + parts[i];
  let bits = words * Math.log2(WORDS.length) + (words - 1) * Math.log2(seps.length);
  if (digits) {
    password += pick(seps) + (randomInt(90) + 10); // two digits, 10-99
    bits += Math.log2(seps.length) + Math.log2(90);
  }
  return { password, bits: Math.round(bits) };
}
