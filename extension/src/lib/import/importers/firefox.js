import { pick } from '../csv.js';
import { toMs } from '../model.js';
import { t } from '../../../shared/i18n.js';
import { collect, entry, fits, readCsv } from './_csv.js';

const SHAPE = {
  all: [['url', 'hostname'], 'username', 'password'],
  any: ['httprealm', 'formactionorigin', 'formsubmiturl', 'guid', 'timecreated', 'timelastused', 'timepasswordchanged'],
};
export const accepts = (headers) => fits(headers, SHAPE);

const SYNC_BOOKKEEPING_URL = /^(chrome:\/\/(firefoxaccounts|weave)|http:\/\/sync\/?$)/i;

const hostAsWritten = (url) => url
  .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  .replace(/^[^/?#@]*@/, '')
  .split(/[/?#]/)[0]
  .replace(/:\d+$/, '');

export async function parse(file) {
  const { records } = readCsv(file, accepts,
    t('Firefox の CSV ではないようです（url, username, password, httpRealm などの列が見つかりません）'));
  const warnings = [];
  let internal = 0;
  const out = collect(records, (r) => {
    const url = pick(r, 'url', 'hostname').trim();
    if (SYNC_BOOKKEEPING_URL.test(url)) { internal++; return null; }
    const realm = String(r.httprealm ?? '').trim();
    return {
      title: hostAsWritten(url),
      url,
      username: r.username,
      password: r.password,
      extra: realm ? [entry(t('import.label.httpRealm', null, 'HTTP 認証の領域'), realm, false)] : [],
      createdAt: toMs(r.timecreated),
      updatedAt: toMs(r.timepasswordchanged),
    };
  }, warnings);
  if (internal) warnings.push(t('Firefox の同期用エントリ {n} 件は取り込みませんでした', { n: internal }));
  return out;
}
