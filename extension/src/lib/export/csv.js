import { toCsv as rowsToCsv } from '../import/csv.js';
import { buildOtpauthUri } from '../totp.js';
import { typeOf, isSecretKind, fieldLabel, optionLabel } from '../../shared/item-types.js';

export const CSV_COLUMNS = Object.freeze(['name', 'url', 'username', 'password', 'note', 'totp', 'vault', 'favorite']);

const FORMULA_PREFIX_RE = /^[=+\-@\t\r]/;

export const noFormula = (v) => {
  const s = v == null ? '' : String(v);
  return FORMULA_PREFIX_RE.test(s) ? "'" + s : s;
};

export function totpUri(item) {
  if (!item.totp) return '';
  return buildOtpauthUri({ ...item.totp, label: item.totp.label || item.username || item.title || '' });
}

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

function noteWithFields(item) {
  const lines = [...templateEntries(item), ...(item.extra || [])]
    .filter((e) => e.value !== '')
    .map((e) => (e.label ? `${e.label}: ${e.value}` : e.value));
  return [item.note, lines.join('\n')].filter(Boolean).join('\n\n');
}

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
