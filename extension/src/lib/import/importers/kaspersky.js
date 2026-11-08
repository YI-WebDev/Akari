import { ImportError, bytesToText, makeImported } from '../model.js';
import { t } from '../../../shared/i18n.js';
import { entry } from './_csv.js';

const HEADING = /^(websites|applications|notes)$/i;
const SEPARATOR = /^-{3,}$/;
const ROLES = {
  'website name': 'site', 'website url': 'url', 'login name': 'loginName', login: 'username',
  password: 'password', comment: 'comment', application: 'app', name: 'name', text: 'text',
};
const MULTILINE = new Set(['comment', 'text']);

function splitBlocks(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const blocks = [];
  let currentBlock = [];
  let hasContent = false;
  const flush = () => {
    if (hasContent) blocks.push(currentBlock);
    currentBlock = [];
    hasContent = false;
  };
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (SEPARATOR.test(trimmed)) return flush();
    const followsBlankLine = !(lines[i - 1] ?? '').trim();
    if (HEADING.test(trimmed) && (!hasContent || followsBlankLine)) return flush();
    if (trimmed) hasContent = true;
    if (hasContent) currentBlock.push(line);
  });
  flush();
  return blocks;
}

function blockKind(fields) {
  if ('site' in fields || 'url' in fields) return 'site';
  if ('app' in fields) return 'app';
  if ('text' in fields || 'name' in fields) return 'note';
  return null;
}

function parseBlock(lines) {
  const f = {};
  const extra = [];
  const loose = [];
  let multilineRole = null;
  let keyed = false;
  for (const line of lines) {
    if (multilineRole) { f[multilineRole] += '\n' + line; continue; }
    const colon = line.indexOf(':');
    if (colon > 0) keyed = true;
    const key = colon > 0 ? line.slice(0, colon).trim().toLowerCase() : '';
    const role = Object.hasOwn(ROLES, key) ? ROLES[key] : null;
    if (role) {
      f[role] = line.slice(colon + 1).replace(/^\s/, '');
      if (MULTILINE.has(role)) multilineRole = role;
    } else if (colon > 0) {
      extra.push(entry(line.slice(0, colon), line.slice(colon + 1).trim()));
    } else if (line.trim()) {
      loose.push(line.trim());
    }
  }
  return { f, extra, loose, kind: blockKind(f), keyed };
}

export function looksLikeKaspersky(text) {
  return /^[ \t]*(websites|applications|notes)[ \t]*$/im.test(text)
    && splitBlocks(text).some((b) => parseBlock(b).kind);
}

export async function parse(file) {
  const items = [];
  let skipped = 0;
  let recognised = 0;
  for (const b of splitBlocks(bytesToText(file.bytes))) {
    const { f, extra, loose, kind, keyed } = parseBlock(b);
    if (!kind) { if (keyed) skipped++; continue; }
    recognised++;
    const rest = loose.join('\n');
    let raw;
    if (kind === 'note') {
      raw = { type: 'note', title: f.name, note: [String(f.text ?? '').trim(), rest].filter(Boolean).join('\n\n'), extra };
    } else {
      const name = (kind === 'site' ? f.site : f.app) ?? '';
      const loginName = String(f.loginName ?? '').trim();
      const user = String(f.username ?? '').trim();
      raw = {
        title: user && loginName ? `${String(name).trim()} (${loginName})` : name,
        url: f.url,
        username: user || loginName,
        password: f.password,
        note: [String(f.comment ?? '').trim(), rest].filter(Boolean).join('\n\n'),
        extra,
      };
    }
    const it = makeImported(raw);
    if (it) items.push(it); else skipped++;
  }
  if (!recognised) {
    throw new ImportError('INVALID_FORMAT',
      t('Kaspersky の TXT ではないようです（Websites / Applications / Notes の項目が見つかりません）'));
  }
  return { items, skipped, warnings: [] };
}
