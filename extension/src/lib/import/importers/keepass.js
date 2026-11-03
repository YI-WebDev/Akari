// KeePass 2.x XML export (KeePassFile/Meta + Root/Group/…/Entry).
// DOMParser exists neither in Node nor in service workers, so a small non-validating
// XML reader is included: elements, attributes, text, CDATA, comments, PIs, DOCTYPE,
// and the predefined + numeric character entities.

import { ImportError, parseOtp, bytesToText } from '../model.js';
import { L, looksSecret } from './_fields.js';
import { normalizeSecret, isValidSecret, base32Encode } from '../../totp.js';
import { fromB64 } from '../../../shared/bytes.js';

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e] ?? m;
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

const badXml = () => new ImportError('INVALID_FORMAT', 'XML として読めませんでした（ファイルが壊れている可能性があります）');
const tooLarge = () => new ImportError('UNSUPPORTED', 'ファイルが大きすぎます');
const NAME = /[^\s/>=]+/y;

// Limits keep a hostile file from exhausting the popup's memory or stack. Real KeePass
// exports use ~20 elements per entry and nest groups a handful of levels deep.
export const MAX_XML_CHARS = 64 * 1024 * 1024;
const MAX_NODES = 1_000_000;
const MAX_DEPTH = 256;

// Leaf elements (most of a KeePass file) share these until they get attributes / children.
const NO_ATTRS = Object.freeze({});
const NO_CHILDREN = Object.freeze([]);
const isBlank = (s) => !/\S/.test(s);
const normEol = (s) => (s.indexOf('\r') < 0 ? s : s.replace(/\r\n?/g, '\n'));

/** Append character data; whitespace between child elements is formatting and is dropped. */
function addText(node, s) {
  if (s && !(node.children.length && isBlank(s))) node.text += s;
}

/**
 * Parse an XML document into `{ name, attrs, children, text }` element nodes
 * (`text` is the concatenated direct character data). Returns the document node.
 * Throws ImportError: INVALID_FORMAT when malformed, UNSUPPORTED past the size limits.
 */
export function parseXml(xml) {
  if (xml.length > MAX_XML_CHARS) throw tooLarge();
  const doc = { name: '#document', attrs: NO_ATTRS, children: [], text: '' };
  const stack = [doc];
  const names = new Map(); // share one string per distinct element name
  const n = xml.length;
  let i = 0, nodes = 0;
  const skipTo = (token, from) => {
    const e = xml.indexOf(token, from);
    if (e < 0) throw badXml();
    return e + token.length;
  };
  while (i < n) {
    const top = stack[stack.length - 1];
    const lt = xml.indexOf('<', i);
    if (lt < 0) { addText(top, decodeEntities(normEol(xml.slice(i)))); break; }
    if (lt > i) addText(top, decodeEntities(normEol(xml.slice(i, lt))));
    if (xml.startsWith('<!--', lt)) { i = skipTo('-->', lt + 4); continue; }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      if (e < 0) throw badXml();
      addText(top, normEol(xml.slice(lt + 9, e)));
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) { i = skipTo('?>', lt + 2); continue; }
    if (xml.startsWith('<!', lt)) { // DOCTYPE, possibly with an internal subset [...]
      let j = lt + 2, depth = 0;
      for (; j < n; j++) {
        const c = xml[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      if (j >= n) throw badXml();
      i = j + 1;
      continue;
    }
    if (xml[lt + 1] === '/') {
      const gt = xml.indexOf('>', lt);
      if (gt < 0 || stack.length < 2 || xml.slice(lt + 2, gt).trim() !== top.name) throw badXml();
      stack.pop();
      i = gt + 1;
      continue;
    }
    // Start tag.
    if (++nodes > MAX_NODES) throw tooLarge();
    NAME.lastIndex = lt + 1;
    const nm = NAME.exec(xml);
    if (!nm) throw badXml();
    let name = names.get(nm[0]);
    if (name === undefined) names.set(nm[0], (name = nm[0]));
    const el = { name, attrs: NO_ATTRS, children: NO_CHILDREN, text: '' };
    let p = NAME.lastIndex;
    let selfClosing = false;
    for (;;) {
      while (p < n && /\s/.test(xml[p])) p++;
      if (p >= n) throw badXml();
      if (xml[p] === '>') { p++; break; }
      if (xml[p] === '/' && xml[p + 1] === '>') { p += 2; selfClosing = true; break; }
      NAME.lastIndex = p;
      const an = NAME.exec(xml);
      if (!an) throw badXml();
      p = NAME.lastIndex;
      while (p < n && /\s/.test(xml[p])) p++;
      if (xml[p] !== '=') throw badXml();
      p++;
      while (p < n && /\s/.test(xml[p])) p++;
      const q = xml[p];
      if (q !== '"' && q !== "'") throw badXml();
      const end = xml.indexOf(q, p + 1);
      if (end < 0) throw badXml();
      if (el.attrs === NO_ATTRS) el.attrs = {};
      el.attrs[an[0]] = decodeEntities(normEol(xml.slice(p + 1, end)));
      p = end + 1;
    }
    if (top.children === NO_CHILDREN) {
      top.children = [];
      if (isBlank(top.text)) top.text = ''; // indentation before the first child
    }
    top.children.push(el);
    if (!selfClosing) {
      if (stack.length > MAX_DEPTH) throw new ImportError('UNSUPPORTED', 'XML の入れ子が深すぎます');
      stack.push(el);
    }
    i = p;
  }
  if (stack.length !== 1) throw badXml();
  return doc;
}

const kids = (node, name) => (node ? node.children.filter((c) => c.name === name) : []);
const kid = (node, name) => (node ? node.children.find((c) => c.name === name) : undefined);
const textOf = (node, name) => kid(node, name)?.text ?? '';

/** KDBX 4 stores times as base64 int64 seconds since 0001-01-01; XML exports use ISO 8601. */
function keepassTime(s) {
  const v = s.trim();
  if (!v) return undefined;
  if (/^[A-Za-z0-9+/]{11}=$/.test(v)) {
    try {
      const b = fromB64(v);
      const secs = Number(new DataView(b.buffer, b.byteOffset, 8).getBigInt64(0, true));
      const ms = (secs - 62135596800) * 1000;
      return ms > 0 ? ms : undefined;
    } catch {
      return undefined;
    }
  }
  const t = Date.parse(v);
  return Number.isFinite(t) && t > 0 ? t : undefined;
}

function hexToBytes(hex) {
  const h = hex.replace(/\s+/g, '');
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(h)) return null;
  return Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
}

const ALGS = { 'HMAC-SHA-1': 'SHA1', 'HMAC-SHA-256': 'SHA256', 'HMAC-SHA-512': 'SHA512' };

function otpConfig(secret, { digits = 6, period = 30, algorithm = 'SHA1' }, label) {
  const s = normalizeSecret(secret);
  if (!isValidSecret(s) || ![6, 8].includes(digits) || !Number.isInteger(period) || period < 1 || period > 300 || !algorithm) return null;
  return { secret: s, algorithm, digits, period, issuer: '', label };
}

/**
 * TOTP from the strings the common KeePass flavours use. Returns the config and the keys it
 * consumed, so anything that could not be understood stays in the note.
 */
function findTotp(strings, label) {
  // KeePassXC: otpauth:// URI in "otp"; KeeOTP plugin: "key=…&step=…&size=…" in "otp".
  const otp = strings.get('otp');
  if (otp) {
    let cfg = parseOtp(otp, label);
    if (!cfg && /(^|&)key=/.test(otp)) {
      const q = new URLSearchParams(otp);
      cfg = otpConfig(q.get('key') || '', {
        digits: Number(q.get('size') || 6),
        period: Number(q.get('step') || 30),
        algorithm: { sha1: 'SHA1', sha256: 'SHA256', sha512: 'SHA512' }[(q.get('otpHashMode') || 'sha1').toLowerCase()],
      }, label);
    }
    if (cfg) return { totp: cfg, used: ['otp'] };
  }
  // KeePass 2.47+: TimeOtp-Secret[-Base32|-Hex|-Base64] + TimeOtp-Length/Period/Algorithm.
  const secretKey = ['TimeOtp-Secret-Base32', 'TimeOtp-Secret', 'TimeOtp-Secret-Hex', 'TimeOtp-Secret-Base64'].find((k) => strings.get(k));
  if (secretKey) {
    const raw = strings.get(secretKey);
    let b32 = null;
    try {
      const bytes = secretKey === 'TimeOtp-Secret' ? new TextEncoder().encode(raw)
        : secretKey === 'TimeOtp-Secret-Hex' ? hexToBytes(raw)
          : secretKey === 'TimeOtp-Secret-Base64' ? fromB64(raw.trim()) : null;
      b32 = secretKey === 'TimeOtp-Secret-Base32' ? raw : bytes && base32Encode(bytes);
    } catch {
      b32 = null;
    }
    const alg = strings.get('TimeOtp-Algorithm');
    const cfg = b32 && otpConfig(b32, {
      digits: Number(strings.get('TimeOtp-Length') || 6),
      period: Number(strings.get('TimeOtp-Period') || 30),
      algorithm: alg ? ALGS[alg.trim().toUpperCase()] : 'SHA1',
    }, label);
    if (cfg) return { totp: cfg, used: [secretKey, 'TimeOtp-Length', 'TimeOtp-Period', 'TimeOtp-Algorithm'] };
  }
  // KeePassXC (old): "TOTP Seed" + "TOTP Settings" = "period;digits" ("S" digits = Steam).
  const seed = strings.get('TOTP Seed');
  if (seed) {
    const [period, digits] = (strings.get('TOTP Settings') || '30;6').split(';');
    const cfg = /^otpauth:/i.test(seed) ? parseOtp(seed, label) : otpConfig(seed, { period: Number(period), digits: Number(digits) }, label);
    if (cfg) return { totp: cfg, used: ['TOTP Seed', 'TOTP Settings'] };
  }
  return { totp: null, used: [] };
}

const STANDARD = new Set(['Title', 'UserName', 'Password', 'URL', 'Notes']);

/** @returns {Promise<{ items: object[], skipped: number, warnings: string[] }>} */
export async function parse(file) {
  if (file.bytes.length > MAX_XML_CHARS) throw tooLarge(); // encoded text has at least as many bytes as chars
  const text = bytesToText(file.bytes);
  if (!/<KeePassFile[\s>]/.test(text)) {
    throw new ImportError('INVALID_FORMAT', 'KeePass の XML（2.x）ではありません。KeePass の「エクスポート → KeePass XML (2.x)」で書き出したファイルを選んでください');
  }
  const kp = kid(parseXml(text), 'KeePassFile');
  const root = kid(kp, 'Root');
  if (!root) throw new ImportError('INVALID_FORMAT', 'KeePass の XML に Root がありません');
  const meta = kid(kp, 'Meta');
  const binEl = kid(meta, 'RecycleBinUUID');
  const binUuid = (binEl?.text || '').trim();
  const isRecycleBin = (g) => (binEl
    ? !!binUuid && !/^A+=*$/.test(binUuid) && textOf(g, 'UUID').trim() === binUuid
    : /^(Recycle Bin|ごみ箱|Trash)$/i.test(textOf(g, 'Name').trim()));

  const items = [];
  let skipped = 0, attachments = 0, badTotp = 0;
  const countEntries = (g) => kids(g, 'Entry').length + kids(g, 'Group').reduce((s, c) => s + countEntries(c), 0);

  const toItem = (entry) => {
    const strings = new Map();
    const hidden = new Set(); // "protect in memory" values: password-like by the user's own choice
    for (const s of kids(entry, 'String')) {
      const key = textOf(s, 'Key').trim();
      const val = kid(s, 'Value');
      if (!key || !val) continue;
      if (/^true$/i.test(val.attrs.Protected || '')) {
        throw new ImportError('UNSUPPORTED', '暗号化された値を含む XML です。KeePass の「エクスポート → KeePass XML (2.x)」で書き出したファイルを選んでください');
      }
      strings.set(key, val.text);
      if (/^true$/i.test(val.attrs.ProtectInMemory || '')) hidden.add(key);
    }
    attachments += kids(entry, 'Binary').length;
    const username = (strings.get('UserName') || '').trim();
    const title = (strings.get('Title') || '').trim();
    const { totp, used } = findTotp(strings, username || title);
    const hadOtp = ['otp', 'TimeOtp-Secret-Base32', 'TimeOtp-Secret', 'TimeOtp-Secret-Hex', 'TimeOtp-Secret-Base64', 'TOTP Seed'].some((k) => strings.get(k));
    if (!totp && hadOtp) badTotp++;
    // Custom strings become extra fields (an OTP setting that could not be used stays there too).
    const extra = [];
    for (const [k, v] of strings) {
      if (STANDARD.has(k) || used.includes(k)) continue;
      if (/^KP2A_URL(_\d+)?$/.test(k)) extra.push({ label: L('url', 'URL'), value: v, secret: false });
      else extra.push({ label: k, value: v, secret: hidden.has(k) || looksSecret(k) });
    }
    const tags = textOf(entry, 'Tags').split(/[;,]/).map((t) => t.trim()).filter(Boolean);
    if (tags.length) extra.push({ label: L('tags', 'タグ'), value: tags.join(', '), secret: false });
    const url = (strings.get('URL') || '').trim();
    const password = strings.get('Password') || '';
    const times = kid(entry, 'Times');
    const item = {
      type: 'note',
      title,
      note: strings.get('Notes') || '',
      extra,
      fav: false,
      createdAt: keepassTime(textOf(times, 'CreationTime')),
      updatedAt: keepassTime(textOf(times, 'LastModificationTime')),
    };
    return username || password || url || totp ? { ...item, type: 'login', url, username, password, totp } : item;
  };

  const walk = (group) => {
    if (isRecycleBin(group)) { skipped += countEntries(group); return; }
    // Entry/History holds older revisions of an entry; only direct entries are read.
    for (const e of kids(group, 'Entry')) items.push(toItem(e));
    for (const g of kids(group, 'Group')) walk(g);
  };
  for (const g of kids(root, 'Group')) walk(g);

  const warnings = [];
  if (attachments) warnings.push(`添付ファイル ${attachments} 件は読み込まれません`);
  if (badTotp) warnings.push(`読み取れない TOTP 設定 ${badTotp} 件はカスタムフィールドに残しました`);
  return { items, skipped, warnings };
}
