import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, scanHtml, tableOf, JA, DOTTED } from './_i18n-scan.js';
import EN from '../../extension/src/shared/locales/en.js';
import { GROUPS, ITEM_TYPES } from '../../extension/src/shared/item-types.js';
import { DEFAULT_VAULTS } from '../../extension/src/shared/messages.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../extension/src');
const read = (file) => readFile(path.join(SRC, file), 'utf8');

const BRAND = '灯';
const isJa = (s) => JA.test(s.replaceAll(BRAND, ''));
const isStatic = (lit) => lit.kind === 'str' || lit.kind === 'full';

const CALLS = [
  { name: 't', key: 0, fallback: 2 },
  { name: 'L', files: /^lib\/import\//, key: 0, prefix: 'import.label.', fallback: 1 },
  { name: 'withSite', files: /^passkey\/passkey\.js$/, key: 1 },
];

function roleOf(file, lit) {
  const c = lit.call && CALLS.find((x) => x.name === lit.call.name && (!x.files || x.files.test(file)));
  if (!c) return null;
  if (lit.call.arg === c.key) return { as: 'key', key: (c.prefix || '') + lit.value };
  if (lit.call.arg === c.fallback) return { as: 'fallback' };
  return null;
}

const isCode = (f) => f.endsWith('.js') && !f.split('/').some((part) => part.startsWith('.'));

async function sources(filter) {
  const files = (await readdir(SRC, { recursive: true })).map((f) => f.split(path.sep).join('/')).filter(filter).sort();
  return Promise.all(files.map(async (file) => {
    const src = await read(file);
    try {
      return { file, src, ...scan(src) };
    } catch (e) {
      throw new Error(`${file}: ${e.message}`);
    }
  }));
}

const PAGES = await sources((f) => isCode(f) && !/^(content|third_party)\//.test(f) && !f.startsWith('shared/locales/'));
const CONTENT = await sources((f) => isCode(f) && f.startsWith('content/') && f !== 'content/i18n-page.js');
const PAGE_EN = tableOf(await read('content/i18n-page.js'), 'EN');
const HTML = ['popup/popup.html', 'passkey/passkey.html'];

const dictOf = (file) => (file.startsWith('content/') ? PAGE_EN : EN);
const has = (dict, key) => Object.hasOwn(dict, key);
const NAMESPACES = new Set(Object.keys(EN).filter((k) => DOTTED.test(k)).map((k) => k.split('.')[0]));

const tableKeys = async (file, ...tables) => {
  const src = await read(file);
  return tables.flatMap((name) => Object.keys(tableOf(src, name)));
};
const FAMILIES = {
  'type.<id>': ITEM_TYPES.map((x) => `type.${x.id}`),
  'group.<id>': GROUPS.map((g) => `group.${g.id}`),
  'field.<type>.<key>': ITEM_TYPES.flatMap((x) => x.fields.map((fd) => `field.${x.id}.${fd.key}`)),
  'option.<type>.<key>.<id>': ITEM_TYPES.flatMap((x) => x.fields.flatMap((fd) => (fd.options || []).map((o) => `option.${x.id}.${fd.key}.${o.id}`))),
  'vaults.hue<h> (popup/views/vaults.js VAULT_HUES)':
    tableOf(await read('popup/views/vaults.js'), 'VAULT_HUES').map((hue) => `vaults.hue${hue}`),
  'vault.default.<id> (shared/messages.js DEFAULT_VAULTS)': DEFAULT_VAULTS.map((v) => `vault.default.${v.id}`),
  'import.label.<column> (importers/dashlane.js LABELS)':
    (await tableKeys('lib/import/importers/dashlane.js', 'LABELS')).map((k) => `import.label.${k}`),
  'import.label.<key> (importers/bitwarden.js EXTRA_LABELS)':
    Object.values(tableOf(await read('lib/import/importers/bitwarden.js'), 'EXTRA_LABELS')).map(([k]) => `import.label.${k}`),
  'import.label.keeper.<key> (importers/keeper.js)':
    (await tableKeys('lib/import/importers/keeper.js', 'BUILTIN_LABELS', 'FIELD_LABELS', 'SUB_LABELS')).map((k) => `import.label.keeper.${k}`),
  'import.label.proton.<key> (importers/protonpass.js LABELS)':
    (await tableKeys('lib/import/importers/protonpass.js', 'LABELS')).map((k) => `import.label.proton.${k}`),
};
const FAMILY_KEYS = Object.values(FAMILIES).flat();

function none(list, what) {
  assert.ok(list.length === 0, `${what} (${list.length}):\n  ${list.join('\n  ')}`);
}

const TYPE_LABELS = [
  ...GROUPS.map((g) => g.label),
  ...ITEM_TYPES.flatMap((x) => [x.label, ...x.fields.flatMap((fd) => [fd.label, ...(fd.options || []).map((o) => o.label)])]),
];

const ALLOW = [
  { file: 'shared/item-types.js', within: ['GROUPS', 'ITEM_TYPES'], literal: TYPE_LABELS, use: 'fallback',
    why: 'labels shown through typeLabel / groupLabel / fieldLabel / optionLabel (type.*, group.*, field.*, option.*)' },
  { file: 'shared/messages.js', within: 'DEFAULT_VAULTS', use: 'fallback', why: 'default vault names: vault.default.<id> (lib/vault/schema.js)' },
  { file: 'popup/views/vaults.js', within: 'HUE_NAMES', use: 'fallback', why: 'colour names: vaults.hue<h>' },
  { file: 'popup/views/health.js', within: 'LABELS', use: 'fallback', why: 'issue names next to their health.* keys' },
  { file: 'popup/views/type-menu.js', within: 'VIEWS', use: 'fallback', why: 'view names next to their list.view* keys' },
  { file: 'lib/import/importers/dashlane.js', within: 'LABELS', use: 'fallback', why: 'column labels: import.label.<column>' },
  { file: 'lib/import/importers/bitwarden.js', within: 'EXTRA_LABELS', use: 'fallback', why: 'labels: import.label.<key>' },
  { file: 'lib/import/importers/keeper.js', within: ['BUILTIN_LABELS', 'FIELD_LABELS', 'SUB_LABELS'], use: 'fallback', why: 'labels: import.label.keeper.<key>' },
  { file: 'lib/import/importers/protonpass.js', within: 'LABELS', use: 'fallback', why: 'labels: import.label.proton.<key>' },

  { file: 'popup/views/format.js', within: 'GROUPS', use: 'key', why: 'list headings: groupName() is t(GROUPS[g])' },
  { file: 'popup/state.js', within: 'COPY_LABEL', use: 'key', why: 'copyText(): t(COPY_LABEL[field])' },
  { file: 'popup/views/export.js', within: 'FORMATS', use: 'key', why: 'format names: t(f.name), t(f.desc), t(f.title)' },
  { file: 'popup/views/import.js', within: 'AKARI', use: 'key', why: 'source name: t(s.name)' },
  { file: 'lib/strength.js', within: 'LABELS', use: 'key', why: 'strength names: t(LABELS[level])' },
  { file: 'lib/import/importers/dashlane.js', within: 'JSON_NOTE_KINDS', literal: ['税務情報'], use: 'key', why: 'note kind' },
  { file: 'lib/import/importers/dashlane.js', literal: ['支払い情報', '税番号', '身分証明書', 'その他'], use: 'key', why: 'note kinds passed to asNote()' },
  { file: 'lib/import/importers/enpass.js', within: ['KINDS', 'kind'], use: 'key', why: 'note kinds' },
  { file: 'lib/import/importers/keeper.js', within: ['TYPES', 'kind'], use: 'key', why: 'note kinds' },
  { file: 'lib/import/importers/onepassword.js', within: ['CATEGORIES', 'TYPE_NAMES', 'kind'], use: 'key', why: 'note kinds' },
  { file: 'lib/import/importers/protonpass.js', within: ['KINDS', 'kind'], use: 'key', why: 'note kinds' },

  { file: 'lib/import/importers/_csv.js', within: 'SECRET_WORD', use: 'data', why: 'column names that mark a secret, matched in CSV headers' },
  { file: 'lib/import/importers/_fields.js', within: 'LABEL_RULES', use: 'data', why: 'field names matched in imported files' },
  { file: 'lib/import/importers/generic.js', within: ['TYPE_COLUMNS', 'FOLDERISH', 'SYNONYMS', 'TYPE_NAMES'], use: 'data', why: 'column and type names matched in CSV files' },
  { file: 'lib/import/importers/protonpass.js', within: 'TEMPLATES', use: 'data', why: "Proton Pass's own Japanese field names, matched in its exports" },
  { file: 'lib/import/importers/protonpass.js', literal: ['秘密', 'APIキー'], use: 'data', why: 'field id and name matched in a Proton Pass API credential' },
  { file: 'background/clipboard.js', literal: ['クリップボードからコピーした秘密を消去する'], use: 'data', why: 'chrome.offscreen justification: read by Chrome, not shown' },

  { file: 'popup/views/settings.js', literal: ['日本語'], use: 'self', why: 'the browser language named in its own language in the 自動 hint ({lang})' },
];

const ALLOW_HTML = [
  { file: 'popup/popup.html', text: ['日本語'], use: 'self', why: 'the 言語 chip: 日本語 is written in Japanese (English in English)' },
  { file: 'passkey/passkey.html', text: ['に使うアカウントを選んでください', 'のパスキーは Akari に保存されていません'], use: 'key',
    why: 'the sentence around the site name: withSite() rebuilds it from t(\'{site} …\') before the screen shows' },
];

const listOf = (v) => (v == null ? null : Array.isArray(v) ? v : [v]);
const allows = (e, file, lit) => e.file === file
  && (!e.within || listOf(e.within).includes(lit.decl))
  && (!e.literal || e.literal.includes(lit.value));

test('the scanner sees every line with Japanese text', () => {
  const lost = [];
  for (const { file, src, tokens } of [...PAGES, ...CONTENT]) {
    const seen = new Set();
    for (const tok of [...tokens, ...tokens.comments]) {
      if (tok.type === 'str' || tok.type === 'tpl' || tok.type === 'regex' || !tok.type) {
        for (let l = tok.line; l <= tok.endLine; l++) seen.add(l);
      }
    }
    src.split('\n').forEach((text, i) => { if (isJa(text) && !seen.has(i + 1)) lost.push(`${file}:${i + 1}  ${text.trim()}`); });
  }
  none(lost, 'Lines the i18n scanner could not read (fix tests/unit/_i18n-scan.js)');
  assert.ok(PAGES.some((s) => s.file === 'popup/views/list.js') && CONTENT.some((s) => s.file === 'content/autofill.js'), 'sources found');
});

test('every static key passed to t() is in the English dictionary', () => {
  const missing = [];
  for (const { file, literals } of PAGES) {
    for (const lit of literals) {
      const role = roleOf(file, lit);
      if (role?.as === 'key') {
        if (!isStatic(lit)) {
          if (isJa(lit.value)) missing.push(`${file}:${lit.line}  ${lit.value}  (key built at run time: use a {placeholder})`);
        } else if ((isJa(role.key) || DOTTED.test(role.key)) && !has(EN, role.key)) {
          missing.push(`${file}:${lit.line}  ${role.key}`);
        }
      } else if (DOTTED.test(lit.value) && NAMESPACES.has(lit.value.split('.')[0]) && !has(EN, lit.value)) {
        missing.push(`${file}:${lit.line}  ${lit.value}`);
      }
    }
  }
  none(missing, 'Keys with no English in shared/locales/en/*.js');
});

test('every key of the dynamic key families is in the English dictionary', () => {
  const missing = [];
  for (const [family, keys] of Object.entries(FAMILIES)) {
    assert.ok(keys.length > 0, `${family}: no keys found`);
    for (const key of keys) if (!has(EN, key)) missing.push(`${family}  ${key}`);
  }
  none(missing, 'Dynamic keys with no English in shared/locales/en/*.js');
});

test('Japanese text in the extension\'s code reaches the screen through t()', () => {
  const stray = [];
  const untranslated = [];
  const used = new Set();
  for (const { file, literals } of [...PAGES, ...CONTENT]) {
    const keys = new Map();
    for (const lit of literals) {
      const role = roleOf(file, lit);
      if (role?.as === 'key' && !keys.has(lit.call.id)) keys.set(lit.call.id, { ...role, lit });
    }
    const fallbackOk = (lit) => {
      const k = keys.get(lit.call.id);
      if (!k) return false;
      if (k.lit.whole) return has(dictOf(file), k.key) || has(dictOf(file), lit.value);
      return /^[a-z]\w*\./.test(k.key) && FAMILY_KEYS.some((fk) => fk.startsWith(k.key));
    };
    for (const lit of literals) {
      if (!isJa(lit.value)) continue;
      const role = roleOf(file, lit);
      if (role?.as === 'key') continue;
      if (role?.as === 'fallback') {
        if (!fallbackOk(lit)) stray.push(`${file}:${lit.line}  ${lit.value}  (fallback of a key that no test checks: add the key, or its family to FAMILIES)`);
        continue;
      }
      const entry = ALLOW.find((e) => allows(e, file, lit));
      if (!entry) {
        stray.push(`${file}:${lit.line}  ${lit.value}`);
        continue;
      }
      used.add(entry);
      if (entry.use === 'key' && !has(dictOf(file), lit.value)) untranslated.push(`${file}:${lit.line}  ${lit.value}`);
    }
  }
  none(stray, 'Japanese text shown without t(): wrap it in t() and add its English, or list it in ALLOW (tests/unit/i18n-coverage.test.js) with the reason');
  none(untranslated, 'Japanese keys passed to t() through a table or variable, with no English in shared/locales/en/*.js');
  none(ALLOW.filter((e) => !used.has(e)).map((e) => `${e.file}  ${listOf(e.within || e.literal).join(', ')}`),
    'ALLOW entries that match nothing any more: remove them');
});

test('the content scripts\' strings are in content/i18n-page.js', () => {
  const missing = [];
  for (const { file, literals } of CONTENT) {
    for (const lit of literals) {
      if (lit.call?.name !== 't' || lit.call.arg !== 0 || !isJa(lit.value)) continue;
      if (!isStatic(lit)) missing.push(`${file}:${lit.line}  ${lit.value}  (key built at run time: use a {placeholder})`);
      else if (!has(PAGE_EN, lit.value)) missing.push(`${file}:${lit.line}  ${lit.value}`);
    }
  }
  none(missing, 'In-page strings with no English in the EN map of content/i18n-page.js');
});

test('the static text of popup.html and passkey.html is in the English dictionary', async () => {
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  const missing = [];
  const used = new Set();
  const allowed = (file, text) => {
    const entry = ALLOW_HTML.find((e) => e.file === file && e.text.includes(text));
    if (entry) used.add(entry);
    return !!entry;
  };
  for (const file of HTML) {
    const { texts, attrs } = scanHtml(await read(file));
    for (const x of texts) {
      const text = x.text.trim();
      if (!isJa(text)) continue;
      if (x.i18n != null) {
        if (!has(EN, x.i18n)) missing.push(`${file}:${x.line}  data-i18n="${x.i18n}"`);
      } else if (!has(EN, text) && !allowed(file, text)) {
        missing.push(`${file}:${x.line}  ${text}`);
      }
    }
    for (const a of attrs) {
      if (a.name === 'data-i18n') {
        if (!has(EN, a.value)) missing.push(`${file}:${a.line}  data-i18n="${a.value}"`);
      } else if (isJa(a.value)) {
        if (!ATTRS.includes(a.name)) missing.push(`${file}:${a.line}  ${a.name}="${a.value}"  (translateDom() translates only ${ATTRS.join(' / ')})`);
        else if (!has(EN, a.value.trim()) && !allowed(file, a.value.trim())) missing.push(`${file}:${a.line}  ${a.name}="${a.value}"`);
      }
    }
  }
  none(missing, 'Static page text with no English in shared/locales/en/*.js');
  none(ALLOW_HTML.filter((e) => !used.has(e)).map((e) => `${e.file}  ${e.text.join(', ')}`),
    'ALLOW_HTML entries that match nothing any more: remove them');
});
