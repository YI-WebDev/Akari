import { utf8, toB64, fromB64, randomBytes } from '../../shared/bytes.js';
import { ATTACHMENT_LIMITS } from '../../shared/messages.js';
import { ATTACHMENT_KEY_PREFIX } from '../../shared/storage-keys.js';
import { decodeBox } from '../crypto.js';
import { invalid, isObject, clampTs } from './common.js';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const MAX_MIME_LENGTH = 100;
const MAX_RAW_NAME_LENGTH = 4096;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const BOX_VERSION = 1;
const NAME_DROP_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

export const isAttachmentId = (v) => typeof v === 'string' && ID_RE.test(v);
export const attachmentStorageKey = (id) => ATTACHMENT_KEY_PREFIX + id;
export const maxAttachmentB64Length = () => Math.ceil(ATTACHMENT_LIMITS.fileBytes / 3) * 4;

export function cleanAttachmentName(name) {
  if (typeof name !== 'string' || name.length > MAX_RAW_NAME_LENGTH) return null;
  const v = name.replace(NAME_DROP_RE, '').replace(/[/\\]/g, '_').trim();
  const n = [...v].length;
  return n >= 1 && n <= ATTACHMENT_LIMITS.name ? v : null;
}

export function cleanMime(mime) {
  if (typeof mime !== 'string' || mime.length > MAX_MIME_LENGTH) return '';
  const v = mime.toLowerCase();
  return MIME_RE.test(v) ? v : '';
}

function isKey(v) {
  if (typeof v !== 'string') return false;
  try {
    return fromB64(v).length === KEY_BYTES;
  } catch {
    return false;
  }
}

export const newAttachmentKey = () => toB64(randomBytes(KEY_BYTES));

const aesKey = (keyB64, usage) => crypto.subtle.importKey('raw', fromB64(keyB64), 'AES-GCM', false, [usage]);
const aad = (id) => utf8('akari:att:v1:' + id);

export async function encryptAttachment(keyB64, id, bytes) {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(id) }, await aesKey(keyB64, 'encrypt'), bytes);
  return { v: BOX_VERSION, iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptAttachment(keyB64, id, box) {
  if (!isObject(box) || box.v !== BOX_VERSION || typeof box.ct !== 'string'
    || box.ct.length > maxAttachmentB64Length() + 32) throw invalid('Malformed attachment');
  const { iv, ct } = decodeBox(box);
  if (iv.length !== IV_BYTES || ct.length < GCM_TAG_BYTES + 1) throw invalid('Malformed attachment');
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(id) }, await aesKey(keyB64, 'decrypt'), ct));
  } catch {
    throw invalid('Attachment failed integrity check');
  }
}

const isValidMeta = (a) => isObject(a) && isAttachmentId(a.id)
  && cleanAttachmentName(a.name) === a.name && typeof a.mime === 'string' && cleanMime(a.mime) === a.mime
  && Number.isInteger(a.size) && a.size >= 1 && a.size <= ATTACHMENT_LIMITS.fileBytes && isKey(a.key);

export function normalizeAttachments(list, nowMs = Date.now()) {
  if (list === undefined) return { list: [], skipped: 0 };
  if (!Array.isArray(list)) return { list: [], skipped: 1 };
  const out = [];
  for (const a of list) {
    if (out.length >= ATTACHMENT_LIMITS.perItem || !isValidMeta(a) || out.some((x) => x.id === a.id)) continue;
    out.push({ id: a.id, name: a.name, mime: a.mime, size: a.size, addedAt: clampTs(a.addedAt, nowMs, nowMs), key: a.key });
  }
  return { list: out, skipped: list.length - out.length };
}

export function keepAttachments(list, stored) {
  if (!Array.isArray(list) || list.length > ATTACHMENT_LIMITS.perItem) throw invalid('Invalid attachments');
  if (!stored) {
    if (list.length) throw invalid('A new item cannot have attachments');
    return [];
  }
  const have = Array.isArray(stored.attachments) ? stored.attachments : [];
  const keep = new Set();
  for (const a of list) {
    if (!isObject(a) || typeof a.id !== 'string' || !have.some((x) => x.id === a.id)) throw invalid('Unknown attachment');
    keep.add(a.id);
  }
  return have.filter((x) => keep.has(x.id));
}

export function attachmentsIn(data) {
  const out = [];
  for (const e of [...(data.items || []), ...(Array.isArray(data.trash) ? data.trash : [])]) {
    if (isObject(e) && Array.isArray(e.attachments)) out.push(...e.attachments.filter(isObject));
  }
  return out;
}

export const attachmentIdsIn = (data) => new Set(attachmentsIn(data).map((a) => a.id));
export const attachmentBytesIn = (data) => attachmentsIn(data).reduce((n, a) => n + (Number.isInteger(a.size) ? a.size : 0), 0);
