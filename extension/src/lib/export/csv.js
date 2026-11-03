// Plain CSV export (PLAN.md §7.3). The first five columns are Chrome's password CSV
// (name,url,username,password,note), so Chrome and most managers can read the file.
// Items of other types (card, identity, …) keep these columns: their template fields and
// custom fields (`extra`) are written into the note column as "label: value" lines after
// the item's own note — secret values included, since CSV is an explicit plaintext export.
// A login's custom fields are appended the same way.

import { toCsv as rowsToCsv } from '../import/csv.js';
import { buildOtpauthUri } from '../totp.js';
import { typeOf, isSecretKind, fieldLabel, optionLabel } from '../../shared/item-types.js';

export const CSV_COLUMNS = Object.freeze(['name', 'url', 'username', 'password', 'note', 'totp', 'vault', 'favorite']);

/**
 * Spreadsheet apps run a cell starting with = + - @ TAB or CR as a formula
 * (=HYPERLINK(...) can leak other cells). Descriptive cells get a leading "'";
 * credentials (username, password, TOTP) are never altered.
 */
export const noFormula = (v) => {
  const s = v == null ? '' : String(v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
};

/** otpauth:// URI of an item's TOTP ('' when none); an empty label falls back to the username or title. */
export function totpUri(item) {
  if (!item.totp) return '';
  return buildOtpauthUri({ ...item.totp, label: item.totp.label || item.username || item.title || '' });
}

/**
 * The item's non-empty template values in template order, with display labels
 * (fieldLabel) and select ids shown as their option label (optionLabel).
 * @returns {{ key: string, label: string, value: string, secret: boolean }[]}
 */
export function templateEntries(item) {
  const fields = item.fields || {};
  return (typeOf(item.type)?.fields || [])
    .filter((fd) => typeof fields[fd.key] === 'string' && fields[fd.key] !== '')
    .map((fd) => ({
      key: fd.key,
      label: fieldLabel(item.type, fd.key),
      value: fd.kind === 'select' ? optionLabel(item.type, fd.key, fields[fd.key]) : fields[fd.key],
      secret: isSecretKind(fd.kind),
    }));
}

/** Item note followed by "label: value" lines for template fields and custom fields. */
function noteWithFields(item) {
  const lines = [...templateEntries(item), ...(item.extra || [])]
    .filter((e) => e.value !== '')
    .map((e) => (e.label ? `${e.label}: ${e.value}` : e.value));
  return [item.note, lines.join('\n')].filter(Boolean).join('\n\n');
}

/**
 * @param {{ vaults: { id: string, name: string }[], items: object[] }} data  decrypted VaultData
 * @returns {string} CSV with a header row and CRLF line endings
 */
export function toCsv(data) {
  const vaultName = new Map(data.vaults.map((v) => [v.id, v.name]));
  const rows = data.items.map((it) => [
    noFormula(it.title), noFormula(it.url), it.username ?? '', it.password ?? '', noFormula(noteWithFields(it)),
    totpUri(it),
    noFormula(vaultName.get(it.vault) ?? it.vault ?? ''),
    it.fav ? 'true' : 'false',
  ]);
  return rowsToCsv([CSV_COLUMNS, ...rows]);
}
