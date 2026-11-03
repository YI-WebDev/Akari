// Enpass JSON export: { folders: [...], items: [{ title, note, category, favorite, trashed,
// archived, createdAt, updated_at, fields: [{ label, type, value, sensitive, deleted }],
// attachments }] }. Folders are ignored.

import { ImportError, fieldsToNote, parseOtp, toMs, bytesToText, parseJson } from '../model.js';

/** Enpass category → Japanese name of the kind converted to a secure note. */
const KINDS = {
  creditcard: 'クレジットカード', identity: '個人情報', finance: '金融情報', license: 'ライセンス',
  travel: '旅行', computer: 'コンピューター', misc: 'その他', document: 'ドキュメント',
};

const str = (v) => (v == null ? '' : String(v).trim());
const joinNote = (...parts) => parts.map(str).filter(Boolean).join('\n\n');
const flag = (v) => v === true || Number(v) === 1;

/** @returns {Promise<{ items: object[], skipped: number, warnings: string[] }>} */
export async function parse(file) {
  const json = parseJson(bytesToText(file.bytes), 'Enpass');
  if (!json || typeof json !== 'object' || !Array.isArray(json.items)) {
    throw new ImportError('INVALID_FORMAT', 'Enpass の書き出しファイル（JSON）ではありません');
  }
  const items = [];
  const converted = {};
  let skipped = 0, attachments = 0, badTotp = 0;

  for (const it of json.items) {
    if (!it || typeof it !== 'object' || flag(it.trashed)) { skipped++; continue; }
    if (Array.isArray(it.attachments)) attachments += it.attachments.length;
    const fields = (Array.isArray(it.fields) ? it.fields : [])
      .filter((f) => f && !flag(f.deleted) && f.type !== 'section' && str(f.value));
    const base = {
      title: it.title,
      fav: flag(it.favorite),
      createdAt: toMs(it.createdAt ?? it.created_at),
      updatedAt: toMs(it.updated_at ?? it.updatedAt),
    };
    const category = str(it.category).toLowerCase();

    if (category === 'login' || category === 'password') {
      const take = (type) => {
        const i = fields.findIndex((f) => f.type === type);
        return i < 0 ? null : fields.splice(i, 1)[0].value;
      };
      const username = take('username') ?? take('email') ?? '';
      const password = take('password') ?? '';
      const url = take('url') ?? '';
      let totp = null;
      const otpRaw = take('totp');
      if (otpRaw) {
        totp = parseOtp(otpRaw, username || it.title);
        if (!totp) { badTotp++; fields.unshift({ label: 'TOTP', value: otpRaw }); }
      }
      items.push({
        ...base, type: 'login', url, username, password, totp,
        note: joinNote(it.note, fieldsToNote(fields.map((f) => [str(f.label) || f.type, f.value]))),
      });
      continue;
    }
    const pairs = fields.map((f) => [str(f.label) || f.type, f.value]);
    if (category === 'note') {
      items.push({ ...base, type: 'note', note: joinNote(it.note, fieldsToNote(pairs)) });
      continue;
    }
    const kind = KINDS[category] || 'その他';
    converted[kind] = (converted[kind] || 0) + 1;
    items.push({ ...base, type: 'note', note: fieldsToNote(pairs, it.note) });
  }

  const warnings = Object.entries(converted).map(([k, n]) => `${k} ${n} 件をセキュアノートとして読み込みました`);
  if (attachments) warnings.push(`添付ファイル ${attachments} 件は読み込まれません`);
  if (badTotp) warnings.push(`読み取れない TOTP 設定 ${badTotp} 件はメモに残しました`);
  return { items, skipped, warnings };
}
