// Import entry point used by the popup. Each source has its own module under
// importers/ exporting `parse(file, ctx) → { items, skipped, warnings }`.

import { ImportError, isPgp, makeImported } from './model.js';

export { ImportError } from './model.js';

/** Order and labels follow the import screen. `exts` drives the file picker. */
export const SOURCES = Object.freeze([
  { id: '1password', name: '1Password', exts: ['1pux', '1pif', 'zip'] },
  { id: 'apple', name: 'Apple Passwords', exts: ['csv'] },
  { id: 'bitwarden', name: 'Bitwarden', exts: ['json', 'zip'] },
  { id: 'brave', name: 'Brave', exts: ['csv'] },
  { id: 'chrome', name: 'Chrome', exts: ['csv'] },
  { id: 'dashlane', name: 'Dashlane', exts: ['zip', 'csv'] },
  { id: 'edge', name: 'Edge', exts: ['csv'] },
  { id: 'enpass', name: 'Enpass', exts: ['json'] },
  { id: 'firefox', name: 'Firefox', exts: ['csv'] },
  { id: 'kaspersky', name: 'Kaspersky', exts: ['txt'] },
  { id: 'keepass', name: 'KeePass', exts: ['xml'] },
  { id: 'keeper', name: 'Keeper', exts: ['json'] },
  { id: 'lastpass', name: 'LastPass', exts: ['csv'] },
  { id: 'nordpass', name: 'NordPass', exts: ['csv'] },
  { id: 'protonpass', name: 'Proton Pass', exts: ['zip', 'pgp', 'csv'] },
  { id: 'roboform', name: 'Roboform', exts: ['csv'] },
  { id: 'safari', name: 'Safari', exts: ['csv'] },
  { id: 'generic', name: 'Generic CSV', exts: ['csv'] },
  { id: 'pgp', name: 'PGP 暗号化', exts: ['pgp', 'gpg', 'asc'] }, // any source above, PGP-encrypted
]);

// Static specifiers so the modules are bundled-free and CSP-friendly ('self' only).
const LOADERS = {
  '1password': () => import('./importers/onepassword.js'),
  apple: () => import('./importers/apple.js'),
  bitwarden: () => import('./importers/bitwarden.js'),
  brave: () => import('./importers/chromium.js'),
  chrome: () => import('./importers/chromium.js'),
  dashlane: () => import('./importers/dashlane.js'),
  edge: () => import('./importers/chromium.js'),
  enpass: () => import('./importers/enpass.js'),
  firefox: () => import('./importers/firefox.js'),
  kaspersky: () => import('./importers/kaspersky.js'),
  keepass: () => import('./importers/keepass.js'),
  keeper: () => import('./importers/keeper.js'),
  lastpass: () => import('./importers/lastpass.js'),
  nordpass: () => import('./importers/nordpass.js'),
  protonpass: () => import('./importers/protonpass.js'),
  roboform: () => import('./importers/roboform.js'),
  safari: () => import('./importers/apple.js'),
  generic: () => import('./importers/generic.js'),
};

/** Some sources' exports are PGP-encrypted as a whole; open them before parsing. */
async function unwrapPgp(file, password) {
  if (!isPgp(file.bytes)) return file;
  if (!password) throw new ImportError('NEEDS_PASSWORD', 'PGP で暗号化されたファイルです。パスフレーズを入力してください');
  const { decryptPgp } = await import('../pgp.js');
  const bytes = await decryptPgp(file.bytes, password); // throws ImportError('BAD_PASSWORD')
  return { name: file.name.replace(/\.(pgp|gpg|asc)$/i, ''), bytes };
}

/**
 * @param {{ source: string, file: { name: string, bytes: Uint8Array }, password?: string }} req
 * @returns {Promise<{ source: string, items: object[], skipped: number, warnings: string[] }>}
 */
export const MAX_FILE_BYTES = 64 * 2 ** 20;

export async function parseImport({ source, file, password }) {
  const meta = SOURCES.find((s) => s.id === source);
  if (!meta) throw new ImportError('UNSUPPORTED', '未対応の読み込み元です: ' + source);
  if (file.bytes.length > MAX_FILE_BYTES) throw new ImportError('UNSUPPORTED', 'ファイルが大きすぎます（64 MB まで）');
  const opened = await unwrapPgp(file, password);

  let id = source;
  if (source === 'pgp') {
    const { detectSource } = await import('./detect.js');
    id = await detectSource(opened);
    if (!id) throw new ImportError('INVALID_FORMAT', '復号したファイルの形式が分かりませんでした');
  }
  const { parse } = await LOADERS[id]();
  const out = await parse(opened, { password, source: id });
  const items = out.items.map(makeImported).filter(Boolean);
  const skipped = (out.skipped || 0) + (out.items.length - items.length);
  if (!items.length) throw new ImportError('EMPTY', '読み込めるアイテムが見つかりませんでした');
  return { source: id, items, skipped, warnings: out.warnings || [] };
}
