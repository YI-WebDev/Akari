// Proton Pass exports:
//  - ZIP with "Proton Pass/data.json": { vaults: { <id>: { name, items: [{ itemId, state
//    (1 active, 2 trashed), pinned, createTime, modifyTime, aliasEmail, data: { type,
//    metadata: { name, note }, content: {...}, extraFields: [...] } }] } } }.
//  - a bare data.json, or a CSV (type,name,url,email,username,password,note,totp,createTime,
//    modifyTime,vault).
//  - .pgp exports are decrypted by index.js first; a ZIP holding data.pgp is opened here.

import { ImportError, fieldsToNote, parseOtp, toMs, bytesToText, parseJson, isZip } from '../model.js';
import { readZip, findEntry } from '../zip.js';
import { csvToObjects } from '../csv.js';

const KINDS = {
  creditCard: 'クレジットカード', identity: '個人情報', alias: 'メールエイリアス', wifi: 'Wi-Fi',
  sshKey: 'SSH キー', custom: 'カスタムアイテム',
};
const LABELS = {
  cardholderName: 'カード名義', number: 'カード番号', verificationCode: 'セキュリティコード',
  expirationDate: '有効期限', pin: 'PIN', ssid: 'SSID', password: 'パスワード', privateKey: '秘密鍵',
  publicKey: '公開鍵', fullName: '氏名', email: 'メール', phoneNumber: '電話', firstName: '名',
  middleName: 'ミドルネーム', lastName: '姓', birthdate: '生年月日', gender: '性別', organization: '組織',
  streetAddress: '住所', zipOrPostalCode: '郵便番号', city: '市区町村', stateOrProvince: '都道府県・州',
  countryOrRegion: '国・地域', company: '会社', jobTitle: '役職', website: 'ウェブサイト',
  socialSecurityNumber: '社会保障番号', passportNumber: 'パスポート番号', licenseNumber: '免許証番号',
  username: 'ユーザー名', url: 'URL', totp: 'TOTP',
};

const str = (v) => (v == null ? '' : String(v).trim());
const joinNote = (...parts) => parts.map(str).filter(Boolean).join('\n\n');

function makeRun() {
  return { items: [], skipped: 0, converted: {}, badTotp: 0, passkeys: 0, attachments: 0 };
}

/** One extra field { fieldName, type, data: { content | totpUri | timestamp } } → [label, value]. */
function extraFieldPair(f) {
  const d = f?.data || {};
  let v = d.content ?? d.totpUri ?? '';
  if (v === '' && d.timestamp != null) {
    const t = new Date(toMs(d.timestamp) ?? NaN);
    v = Number.isFinite(t.getTime()) ? t.toISOString().slice(0, 10) : str(d.timestamp);
  }
  return [str(f?.fieldName) || 'フィールド', v];
}

const MAX_DEPTH = 8; // item content is at most a few levels deep; ignore anything deeper

/**
 * Flatten item content into [label, value] pairs: scalars (enum numbers/booleans are dropped),
 * extra-field arrays, and sections ({ sectionName, sectionFields }).
 */
function flatten(obj, out, depth = 0) {
  if (depth > MAX_DEPTH) return out;
  for (const [k, v] of Object.entries(obj && typeof obj === 'object' ? obj : {})) {
    if (v == null || v === '' || typeof v === 'number' || typeof v === 'boolean') continue;
    if (Array.isArray(v)) {
      for (const x of v) {
        if (x && typeof x === 'object' && 'fieldName' in x) out.push(extraFieldPair(x));
        else if (x && typeof x === 'object' && Array.isArray(x.sectionFields)) {
          for (const f of x.sectionFields) out.push(extraFieldPair(f));
        } else if (typeof x === 'string') out.push([LABELS[k] || k, x]);
      }
    } else if (typeof v === 'object') {
      flatten(v, out, depth + 1);
    } else {
      out.push([LABELS[k] || k, v]);
    }
  }
  return out;
}

function pushLogin(run, p) {
  const otpExtras = [];
  let totp = null;
  for (const raw of p.totps.map(str).filter(Boolean)) {
    const cfg = !totp && parseOtp(raw, p.username || p.title);
    if (cfg) totp = cfg;
    else {
      if (!parseOtp(raw)) run.badTotp++;
      otpExtras.push(['TOTP', raw]);
    }
  }
  const urls = [...new Set(p.urls.map(str).filter(Boolean))];
  run.items.push({
    type: 'login', title: p.title, url: urls[0] || '', username: p.username, password: p.password, totp,
    fav: p.fav, createdAt: p.createdAt, updatedAt: p.updatedAt,
    note: joinNote(p.note, fieldsToNote([...urls.slice(1).map((u) => ['URL', u]), ...otpExtras, ...p.extras])),
  });
}

function fromJson(run, json) {
  if (json?.encrypted === true) {
    throw new ImportError('UNSUPPORTED', '暗号化された Proton Pass の書き出しは、PGP 暗号化（.pgp）か暗号化なしで書き出したファイルを選んでください');
  }
  if (!json || typeof json !== 'object' || !json.vaults || typeof json.vaults !== 'object') {
    throw new ImportError('INVALID_FORMAT', 'Proton Pass の書き出しファイル（data.json）ではありません');
  }
  for (const vault of Object.values(json.vaults)) {
    for (const it of Array.isArray(vault?.items) ? vault.items : []) {
      if (!it || typeof it !== 'object' || !it.data || it.state === 2) { run.skipped++; continue; }
      const d = it.data;
      const m = d.metadata || {};
      const c = d.content && typeof d.content === 'object' ? d.content : {};
      const base = { title: str(m.name), fav: it.pinned === true, createdAt: toMs(it.createTime), updatedAt: toMs(it.modifyTime) };
      const extraFields = Array.isArray(d.extraFields) ? d.extraFields : [];
      const extraTotps = extraFields.filter((f) => f?.type === 'totp').map((f) => f?.data?.totpUri);
      const extras = extraFields.filter((f) => f?.type !== 'totp').map(extraFieldPair);

      if (d.type === 'login') {
        if (Array.isArray(c.passkeys)) run.passkeys += c.passkeys.length;
        const email = str(c.itemEmail), user = str(c.itemUsername || c.username);
        pushLogin(run, {
          ...base,
          username: user || email,
          password: c.password,
          urls: Array.isArray(c.urls) ? c.urls : [],
          totps: [c.totpUri, ...extraTotps],
          extras: user && email ? [['メール', email], ...extras] : extras,
          note: m.note,
        });
        continue;
      }
      const otpPairs = extraTotps.map((t) => ['TOTP', t]);
      if (d.type === 'note') {
        run.items.push({ ...base, type: 'note', note: joinNote(m.note, fieldsToNote([...extras, ...otpPairs])) });
        continue;
      }
      const kind = KINDS[d.type] || 'その他のアイテム';
      const pairs = d.type === 'alias' ? [['エイリアス', it.aliasEmail]] : flatten(c, []);
      run.converted[kind] = (run.converted[kind] || 0) + 1;
      run.items.push({ ...base, type: 'note', note: fieldsToNote([...pairs, ...extras, ...otpPairs], m.note) });
    }
  }
}

function fromCsv(run, text) {
  const { headers, records } = csvToObjects(text);
  if (!headers.includes('type') || !headers.includes('name')) {
    throw new ImportError('INVALID_FORMAT', 'Proton Pass の書き出しファイル（CSV）ではありません');
  }
  for (const rec of records) {
    const type = str(rec.type);
    const base = { title: str(rec.name), createdAt: toMs(rec.createtime), updatedAt: toMs(rec.modifytime) };
    // Several URLs are joined in one cell; split only where the next part starts with a scheme.
    // (Linear pattern: no \s* on both sides of an alternative, which backtracks quadratically.)
    const urls = str(rec.url).split(/\r?\n|,(?=\s*[a-z][a-z0-9+.-]*:\/\/)/i).map(str);
    const email = str(rec.email), user = str(rec.username);
    if (type === 'login' || !type) {
      pushLogin(run, {
        ...base, fav: false, username: user || email, password: rec.password, urls, totps: [rec.totp],
        extras: user && email ? [['メール', email]] : [], note: rec.note,
      });
    } else if (type === 'note') {
      run.items.push({ ...base, type: 'note', note: rec.note });
    } else {
      const kind = KINDS[type] || 'その他のアイテム';
      run.converted[kind] = (run.converted[kind] || 0) + 1;
      const pairs = [['URL', rec.url], ['メール', email], ['ユーザー名', user], ['パスワード', rec.password], ['TOTP', rec.totp]];
      run.items.push({ ...base, type: 'note', note: fieldsToNote(type === 'alias' ? [['エイリアス', email], ...pairs.slice(2)] : pairs, rec.note) });
    }
  }
}

/** @returns {Promise<{ items: object[], skipped: number, warnings: string[] }>} */
export async function parse(file, ctx = {}) {
  const run = makeRun();
  if (isZip(file.bytes)) {
    const entries = readZip(file.bytes);
    const data = findEntry(entries, 'Proton Pass/data.json', 'data.json');
    let json;
    if (data) {
      json = parseJson(bytesToText(await data.bytes()), 'Proton Pass');
    } else {
      const pgp = findEntry(entries, 'Proton Pass/data.pgp', 'data.pgp');
      if (!pgp) throw new ImportError('INVALID_FORMAT', 'Proton Pass の ZIP に data.json が見つかりませんでした');
      if (!ctx.password) throw new ImportError('NEEDS_PASSWORD', 'PGP で暗号化された Proton Pass の書き出しです。パスフレーズを入力してください');
      const { decryptPgp } = await import('../../pgp.js');
      json = parseJson(bytesToText(await decryptPgp(await pgp.bytes(), ctx.password)), 'Proton Pass');
    }
    run.attachments = entries.filter((e) => e !== data && /(^|\/)files\//i.test(e.name)).length;
    fromJson(run, json);
  } else {
    const text = bytesToText(file.bytes);
    if (/^\s*\{/.test(text)) fromJson(run, parseJson(text, 'Proton Pass'));
    else fromCsv(run, text);
  }
  const warnings = Object.entries(run.converted).map(([k, n]) => `${k} ${n} 件をセキュアノートとして読み込みました`);
  if (run.passkeys) warnings.push(`Proton Pass のパスキー ${run.passkeys} 件は形式が異なるため読み込めませんでした`);
  if (run.attachments) warnings.push(`添付ファイル ${run.attachments} 件は読み込まれません`);
  if (run.badTotp) warnings.push(`読み取れない TOTP 設定 ${run.badTotp} 件はメモに残しました`);
  return { items: run.items, skipped: run.skipped, warnings };
}
