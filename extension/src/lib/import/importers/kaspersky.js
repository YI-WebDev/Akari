// Kaspersky Password Manager "Export to TXT":
//
//   Websites
//
//   Website name: Example
//   Website URL: https://example.com
//   Login name: Work            (a label for the account)
//   Login: alice@example.com    (the user name)
//   Password: secret
//   Comment: free text, may span
//   several lines
//   ---
//   Applications           -> Application / Login name / Login / Password / Comment
//   Notes                  -> Name / Text (multi-line)
//
// Only the English headings and keys are known (not confirmed for localized exports).
// Entries are told apart by their keys, so the section headings only mark boundaries.

import { ImportError, bytesToText, makeImported } from '../model.js';

const HEADING = /^(websites|applications|notes)$/i;
const SEPARATOR = /^-{3,}$/;
const ROLES = {
  'website name': 'site', 'website url': 'url', 'login name': 'loginName', login: 'username',
  password: 'password', comment: 'comment', application: 'app', name: 'name', text: 'text',
};
const MULTILINE = new Set(['comment', 'text']);

// Everything here is a single linear pass over the lines: untrusted files can be huge and
// full of blank lines, so no per-line rescans of the current block and no regex that lets
// \s run across line breaks.
function splitBlocks(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const blocks = [];
  let cur = [];
  let filled = false; // does `cur` hold a non-blank line yet?
  const flush = () => {
    if (filled) blocks.push(cur);
    cur = [];
    filled = false;
  };
  lines.forEach((line, i) => {
    const t = line.trim();
    if (SEPARATOR.test(t)) return flush();
    if (HEADING.test(t) && (!filled || !(lines[i - 1] ?? '').trim())) return flush();
    if (t) filled = true;
    if (filled) cur.push(line); // blank lines before the first entry line are not kept
  });
  flush();
  return blocks;
}

function parseBlock(lines) {
  const f = {};
  const extra = [];
  let multi = null;
  let keyed = false;
  for (const line of lines) {
    if (multi) { f[multi] += '\n' + line; continue; }
    const colon = line.indexOf(':'); // "Key: value", split at the first colon
    if (colon > 0) keyed = true;
    const key = colon > 0 ? line.slice(0, colon).trim().toLowerCase() : '';
    const role = Object.hasOwn(ROLES, key) ? ROLES[key] : null;
    if (role) {
      f[role] = line.slice(colon + 1).replace(/^\s/, '');
      if (MULTILINE.has(role)) multi = role;
    } else if (line.trim()) {
      extra.push(line.trim());
    }
  }
  const kind = 'site' in f || 'url' in f ? 'site' : 'app' in f ? 'app' : 'text' in f || 'name' in f ? 'note' : null;
  return { f, extra, kind, keyed };
}

/** True when `text` has a Kaspersky section heading and at least one recognisable entry. */
export function looksLikeKaspersky(text) {
  return /^[ \t]*(websites|applications|notes)[ \t]*$/im.test(text)
    && splitBlocks(text).some((b) => parseBlock(b).kind);
}

export async function parse(file) {
  const items = [];
  let skipped = 0;
  let recognised = 0;
  for (const b of splitBlocks(bytesToText(file.bytes))) {
    const { f, extra, kind, keyed } = parseBlock(b);
    if (!kind) { if (keyed) skipped++; continue; }
    recognised++;
    const rest = extra.join('\n'); // lines with keys we do not know: kept, not dropped
    let raw;
    if (kind === 'note') {
      raw = { type: 'note', title: f.name, note: [String(f.text ?? '').trim(), rest].filter(Boolean).join('\n\n') };
    } else {
      const name = (kind === 'site' ? f.site : f.app) ?? '';
      const loginName = String(f.loginName ?? '').trim();
      const user = String(f.username ?? '').trim();
      // "Login name" labels the account; with no separate "Login" it is the user name itself.
      raw = {
        title: user && loginName ? `${String(name).trim()} (${loginName})` : name,
        url: f.url,
        username: user || loginName,
        password: f.password,
        note: [String(f.comment ?? '').trim(), rest].filter(Boolean).join('\n\n'),
      };
    }
    const it = makeImported(raw);
    if (it) items.push(it); else skipped++;
  }
  if (!recognised) {
    throw new ImportError('INVALID_FORMAT',
      'Kaspersky の TXT ではないようです（Websites / Applications / Notes の項目が見つかりません）');
  }
  return { items, skipped, warnings: [] };
}
