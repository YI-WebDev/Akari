// Password strength estimate (heuristic, deterministic, no network).
//
// Baseline is the design's `charset pool ^ length`. On top of that the password is split into
// the cheapest mix of "guessable" tokens (very common passwords, romaji words from the passphrase
// list, keyboard/alphabet/digit sequences, repeats, years, separators) and plain characters.
// The result never exceeds the baseline.
import WORDS from './wordlist.js';

const LABELS = ['—', '弱い', '普通', '強い', '非常に強い'];
const MAX_ANALYSED = 128; // longer passwords are scored on their first 128 characters
const WORD_BITS = Math.log2(WORDS.length);
const YEAR_BITS = Math.log2(90); // 1950-2039
const DIGIT_BITS = Math.log2(10);
const SEP_BITS = 3; // one punctuation character between two words
const MAX_REPEAT_UNIT = 24;

const WORD_SET = new Set(WORDS);

// Very common passwords, roughly in order of popularity (rank = cost).
const COMMON = `
123456 password 12345678 qwerty 123456789 12345 1234 111111 1234567 dragon 123123 baseball abc123 football monkey letmein shadow master
666666 qwertyuiop 123321 mustang 1234567890 michael 654321 superman 1qaz2wsx 7777777 121212 000000 qazwsx 123qwe killer trustno1 jordan
jennifer zxcvbnm asdfgh hunter buster soccer harley batman andrew tigger sunshine iloveyou 2000 charlie robert thomas hockey ranger daniel
starwars 112233 george computer michelle jessica pepper 1111 zxcvbn 555555 11111111 131313 freedom 777777 pass maggie 159753 aaaaaa ginger
princess joshua cheese amanda summer love ashley nicole chelsea biteme matthew access yankees 987654321 dallas austin thunder taylor matrix
password1 password123 passw0rd p@ssword p@ssw0rd admin administrator admin123 root toor guest user test test123 welcome welcome1 login
master123 qwerty123 qwerty1 1q2w3e4r 1q2w3e 1qazxsw2 zaq12wsx qweasd qweasdzxc asdfghjkl asdf1234 abcd1234 abcdef abc12345 a1b2c3 12341234
11223344 123456a a123456 1234qwer iloveu iloveyou1 lovely sunshine1 princess1 monkey1 dragon1 football1 baseball1 superman1 letmein1 secret
hello hello123 hellokitty whatever changeme default internet google facebook twitter youtube apple samsung windows mypassword pass123 pass1234
passpass login123 flower angel forever blessed cookie hottie liverpool arsenal barcelona manchester
sakura daisuki aishiteru ganbare ganbaru nihon nippon japan tokyo osaka kyoto naruto doraemon pokemon pikachu kawaii arigatou konnichiwa
sayonara ohayou akari hikari yamada tanaka suzuki sato takahashi watanabe ito yamamoto nakamura kobayashi kato yoshida yamaguchi matsumoto
inoue kimura hayashi shimizu saito yamazaki mori abe ikeda hashimoto ishikawa ogawa goto okada hasegawa fujita kondo maeda
`.split(/\s+/).filter(Boolean);

const COMMON_RANK = new Map();
COMMON.forEach((w, i) => { if (!COMMON_RANK.has(w)) COMMON_RANK.set(w, i + 1); });
const MAX_COMMON_LEN = Math.max(...COMMON.map((w) => w.length));

const LEET = { '@': 'a', 4: 'a', 3: 'e', 1: 'i', 0: 'o', $: 's', 5: 's', 7: 't', '!': 'i' };
const LEET_L = { ...LEET, 1: 'l', '!': 'l' };

// Straight-line runs: alphabet, digits and keyboard rows (either direction).
const TRACKS = [
  'abcdefghijklmnopqrstuvwxyz', '0123456789', '1234567890',
  'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '!@#$%^&*()',
];

export function estimateStrength(password) {
  if (typeof password !== 'string' || !password) return result(0);
  const s = password.length > MAX_ANALYSED ? password.slice(0, MAX_ANALYSED) : password;
  let bits = analyse(s, Math.log2(poolSize(password) || 1), new Map());
  // word + digits as in the design; also "Summer2024!" (at most one capital, digits, then a symbol)
  if (password.length < 14 && (/^[a-z]+\d+$/i.test(password) || /^[A-Z]?[a-z]{3,}\d{1,4}[^a-z\d]{1,2}$/.test(password))) {
    bits = Math.min(bits, 28);
  }
  return result(Math.max(1, Math.round(bits)));
}

function result(bits) {
  const level = bits === 0 ? 0 : bits < 40 ? 1 : bits < 64 ? 2 : bits < 88 ? 3 : 4;
  return { bits, level, label: LABELS[level] };
}

function poolSize(p) {
  let pool = 0;
  if (/[a-z]/.test(p)) pool += 26;
  if (/[A-Z]/.test(p)) pool += 26;
  if (/\d/.test(p)) pool += 10;
  if (/[\x00-\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]/.test(p)) pool += 32;
  if (/[^\x00-\x7f]/.test(p)) pool += 100; // kana / kanji / emoji etc.
  return pool;
}

const lowerChars = (s) => {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const l = s[i].toLowerCase();
    out += l.length === 1 ? l : s[i];
  }
  return out;
};

const deleet = (s, map) => {
  let out = '';
  for (let i = 0; i < s.length; i++) out += map[s[i]] || s[i];
  return out;
};

// log2 of the number of ways to choose k upper-case positions among n letters
function chooseBits(n, k) {
  k = Math.min(k, n - k);
  let b = 0;
  for (let i = 1; i <= k; i++) b += Math.log2((n - k + i) / i);
  return b;
}

// Extra guesses for capitalisation of a dictionary token.
function caseBits(orig) {
  let letters = 0;
  let up = 0;
  for (let i = 0; i < orig.length; i++) {
    const c = orig[i];
    if (c.toLowerCase() !== c.toUpperCase()) {
      letters++;
      if (c === c.toUpperCase()) up++;
    }
  }
  if (!up) return 0;
  if (up === letters) return 1; // ALL CAPS
  if (up === 1 && orig[0] !== orig[0].toLowerCase()) return 1; // Capitalised
  return Math.max(2, chooseBits(letters, up));
}

/** Cheapest decomposition of `s` into tokens and plain characters, in bits. */
function analyse(s, poolBits, cache) {
  const n = s.length;
  const lc = lowerChars(s);
  const variants = [lc, deleet(lc, LEET), deleet(lc, LEET_L)];

  // Plain-character cost; digits in a run of 4+ (or a trailing run) are only drawn from 10 symbols.
  const brute = new Float64Array(n).fill(poolBits);
  for (let i = 0; i < n; ) {
    if (s[i] < '0' || s[i] > '9') { i++; continue; }
    let j = i;
    while (j < n && s[j] >= '0' && s[j] <= '9') j++;
    if (j - i >= 4 || j === n) for (let k = i; k < j; k++) brute[k] = Math.min(poolBits, DIGIT_BITS);
    i = j;
  }

  const tokens = new Array(n); // tokens[i] = [{ end, bits, word, sep }]
  const add = (i, end, bits, kind) => (tokens[i] ||= []).push({ end, bits, word: kind === 'word', sep: kind === 'sep' });

  for (let i = 0; i < n; i++) {
    // very common passwords (optionally with leetspeak / capitals)
    for (let len = Math.min(MAX_COMMON_LEN, n - i); len >= 1; len--) {
      if (len < 4 && !(i === 0 && len === n)) break;
      let best = Infinity;
      for (let v = 0; v < 3; v++) {
        const rank = COMMON_RANK.get(variants[v].slice(i, i + len));
        if (!rank) continue;
        let leet = 0;
        if (v) for (let k = i; k < i + len; k++) if (variants[v][k] !== lc[k]) leet++;
        best = Math.min(best, Math.log2(rank + 1) + (leet ? 1 + Math.min(leet, 3) : 0));
      }
      if (best < Infinity) add(i, i + len, best + caseBits(s.slice(i, i + len)), 'word');
    }

    // words from the passphrase list
    for (let len = Math.min(8, n - i); len >= 3; len--) {
      if (WORD_SET.has(lc.slice(i, i + len))) add(i, i + len, WORD_BITS + caseBits(s.slice(i, i + len)), 'word');
    }

    // alphabet / digit / keyboard runs
    for (const track of TRACKS) {
      const j = track.indexOf(lc[i]);
      if (j < 0) continue;
      for (const dir of [1, -1]) {
        let k = 1;
        while (i + k < n && track[j + dir * k] === lc[i + k]) k++;
        if (k >= 4) add(i, i + k, 4 + Math.log2(k), 'seq');
      }
    }

    // repeated unit: "aaaa", "abab", "123123", "passwordpassword"
    for (let p = 1; p <= MAX_REPEAT_UNIT && i + 2 * p <= n; p++) {
      const unit = s.slice(i, i + p);
      if (i >= p && s.startsWith(unit, i - p)) continue; // the run starts earlier
      let end = i + p;
      while (end + p <= n && s.startsWith(unit, end)) end += p;
      const times = (end - i) / p;
      if (times >= 2 && (p > 1 ? end - i >= 4 : times >= 3)) {
        if (!cache.has(unit)) cache.set(unit, analyse(unit, poolBits, cache));
        add(i, end, cache.get(unit) + Math.log2(times), 'rep');
      }
    }

    // years 1950-2039
    if (/^(?:19[5-9]\d|20[0-3]\d)/.test(s.slice(i, i + 4))) add(i, i + 4, YEAR_BITS, 'year');

    // a single punctuation mark joining two words
    if (!/[A-Za-z0-9]/.test(s[i]) && s.charCodeAt(i) < 128) add(i, i + 1, SEP_BITS, 'sep');
  }

  const best = new Float64Array(n + 1).fill(Infinity); // cheapest cover of s[0..i)
  const bestWord = new Float64Array(n + 1).fill(Infinity); // ... whose last token is a word
  best[0] = 0;
  for (let i = 0; i < n; i++) {
    if (best[i] + brute[i] < best[i + 1]) best[i + 1] = best[i] + brute[i];
    for (const t of tokens[i] || []) {
      const from = t.sep ? bestWord[i] : best[i];
      const cost = from + t.bits;
      if (cost < best[t.end]) best[t.end] = cost;
      if (t.word && cost < bestWord[t.end]) bestWord[t.end] = cost;
    }
  }
  return best[n];
}
