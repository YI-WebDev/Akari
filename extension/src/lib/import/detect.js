// Work out which export a decrypted PGP payload (or any file) is.
// detectSource({ name, bytes }) → source id (see SOURCES in index.js) | null.
//
// Chrome, Brave and Edge share one CSV format, so a match is reported as 'chrome'; Safari's is
// the same as Apple Passwords' ('apple'). Both load the same importer module either way.

import { csvToObjects } from './csv.js';
import { ImportError, bytesToText, isZip } from './model.js';
import { findEntry, readZip } from './zip.js';
import { accepts as appleCsv } from './importers/apple.js';
import { accepts as chromiumCsv } from './importers/chromium.js';
import { accepts as firefoxCsv } from './importers/firefox.js';
import { accepts as genericCsv } from './importers/generic.js';
import { looksLikeKaspersky } from './importers/kaspersky.js';
import { accepts as lastpassCsv } from './importers/lastpass.js';
import { accepts as nordpassCsv } from './importers/nordpass.js';
import { accepts as roboformCsv } from './importers/roboform.js';

const ONEPIF_SEPARATOR = '***5642bee8-a5ff-11dc-8314-0800200c9a66***';
const CHROMIUM_COLUMNS = ['name', 'url', 'username', 'password', 'note'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function tryJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** Bitwarden (plain or password-protected), Enpass, Keeper, Proton Pass and legacy Dashlane JSON exports. */
function jsonSource(j) {
  if (!isObj(j)) return null;
  if (Array.isArray(j.AUTHENTIFIANT) || Array.isArray(j.SECURENOTE)) return 'dashlane';
  if (isObj(j.vaults) || Array.isArray(j.vaults)) return 'protonpass';
  if (Array.isArray(j.records)) return 'keeper';
  if (typeof j.encrypted === 'boolean' && ('items' in j || 'encKeyValidation_DO_NOT_EDIT' in j || 'passwordProtected' in j)) {
    return 'bitwarden';
  }
  if (Array.isArray(j.items)) {
    const first = j.items.find(isObj);
    if (first && Array.isArray(first.fields) && !('login' in first)) return 'enpass';
    if (first && ('login' in first || 'secureNote' in first || 'card' in first || 'identity' in first || typeof first.type === 'number')) return 'bitwarden';
    if (Array.isArray(j.folders) && !j.items.length) return 'bitwarden';
  }
  return null;
}

// A ZIP that is corrupt or holds something else just is not a known export (null), but
// UNSUPPORTED (too large / too many entries / ZIP64 / password-protected) is an answer the
// user needs to see, so it propagates instead of being reported as "unknown format".
function notThisFormat(e) {
  if (e instanceof ImportError && e.code === 'UNSUPPORTED') throw e;
  return null;
}

// Speculative probing of unrelated .json entries stays cheap: a few, none of them huge.
const PROBE_ENTRIES = 4;
const PROBE_MAX_BYTES = 16 * 2 ** 20;

async function zipSource(bytes) {
  let entries;
  try { entries = readZip(bytes); } catch (e) { return notThisFormat(e); }
  if (findEntry(entries, 'export.data')) return '1password';
  const proton = entries.find((e) => /(^|\/)proton pass\/data\.json$/i.test(e.name));
  const data = proton || findEntry(entries, 'data.json');
  if (data) {
    if (proton) return 'protonpass';
    try { return jsonSource(JSON.parse(await data.text())); } catch (e) { return notThisFormat(e); }
  }
  if (findEntry(entries, 'credentials.csv')) return 'dashlane';
  // Legacy Dashlane JSON, zipped. Failures here say nothing about the archive: just move on.
  const jsons = entries.filter((x) => /\.json$/i.test(x.name) && x.size <= PROBE_MAX_BYTES).slice(0, PROBE_ENTRIES);
  for (const e of jsons) {
    try { if (jsonSource(JSON.parse(await e.text())) === 'dashlane') return 'dashlane'; } catch { /* not JSON / unreadable */ }
  }
  return null;
}

/** Header fingerprints of the CSV exports whose columns overlap with the simple formats. */
const protonCsv = (h) => ['type', 'name', 'url', 'username', 'password', 'vault'].every((c) => h.includes(c))
  && (h.includes('createtime') || h.includes('modifytime') || h.includes('email'));
const dashlaneCsv = (h) => ['username', 'title', 'password'].every((c) => h.includes(c))
  && (h.includes('username2') || h.includes('otpsecret'));
const chromiumOnly = (h) => chromiumCsv(h) && h.every((c) => CHROMIUM_COLUMNS.includes(c));

function csvSource(text) {
  const nl = text.search(/\r?\n/);
  let headers;
  try {
    ({ headers } = csvToObjects(nl < 0 ? text : text.slice(0, nl)));
  } catch {
    return null; // a "header" wider than the CSV column cap is not any known export
  }
  if (headers.length < 2) return null;
  // Most specific first: later formats' columns are subsets of earlier ones.
  if (protonCsv(headers)) return 'protonpass';
  if (dashlaneCsv(headers)) return 'dashlane';
  if (lastpassCsv(headers)) return 'lastpass';
  if (nordpassCsv(headers)) return 'nordpass';
  if (roboformCsv(headers)) return 'roboform';
  if (firefoxCsv(headers)) return 'firefox';
  if (appleCsv(headers)) return 'apple';
  if (chromiumOnly(headers)) return 'chrome';
  if (genericCsv(headers)) return 'generic';
  return null;
}

/**
 * @param {{ name?: string, bytes: Uint8Array }} file
 * @returns {Promise<string|null>}
 */
export async function detectSource({ bytes }) {
  if (!bytes || !bytes.length) return null;
  if (isZip(bytes)) return zipSource(bytes);

  const text = bytesToText(bytes);
  const head = text.trimStart();
  if (head.includes(ONEPIF_SEPARATOR)) return '1password';
  if (head.startsWith('{') || head.startsWith('[')) return jsonSource(tryJson(head));
  if (head.startsWith('<')) return /<KeePassFile[\s>]/.test(head) ? 'keepass' : null;
  if (looksLikeKaspersky(text)) return 'kaspersky';
  return csvSource(head);
}
