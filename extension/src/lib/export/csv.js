// Plain CSV export (PLAN.md §7.3). The first five columns are Chrome's password CSV
// (name,url,username,password,note), so Chrome and most managers can read the file.

import { toCsv as rowsToCsv } from '../import/csv.js';
import { buildOtpauthUri } from '../totp.js';

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
 * @param {{ vaults: { id: string, name: string }[], items: object[] }} data  decrypted VaultData
 * @returns {string} CSV with a header row and CRLF line endings
 */
export function toCsv(data) {
  const vaultName = new Map(data.vaults.map((v) => [v.id, v.name]));
  const rows = data.items.map((it) => [
    noFormula(it.title), noFormula(it.url), it.username, it.password, noFormula(it.note),
    totpUri(it),
    noFormula(vaultName.get(it.vault) ?? it.vault ?? ''),
    it.fav ? 'true' : 'false',
  ]);
  return rowsToCsv([CSV_COLUMNS, ...rows]);
}
