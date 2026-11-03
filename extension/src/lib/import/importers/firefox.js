// Firefox "Export logins" CSV:
// url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed,timePasswordChanged
// (timestamps in ms). Older exports call the first column "hostname". Firefox has no
// titles, so the title is the host (makeImported derives it from the url).

import { pick } from '../csv.js';
import { toMs } from '../model.js';
import { collect, fits, readCsv } from './_csv.js';

const SHAPE = {
  all: [['url', 'hostname'], 'username', 'password'],
  any: ['httprealm', 'formactionorigin', 'formsubmiturl', 'guid', 'timecreated', 'timelastused', 'timepasswordchanged'],
};
export const accepts = (headers) => fits(headers, SHAPE);

// Firefox Accounts / Sync bookkeeping rows that show up in the export; not user logins.
const INTERNAL_URL = /^(chrome:\/\/(firefoxaccounts|weave)|http:\/\/sync\/?$)/i;

// Host as written in the url (IDN stays readable; `new URL().hostname` would punycode it).
const hostText = (url) => url
  .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  .replace(/^[^/?#@]*@/, '')
  .split(/[/?#]/)[0]
  .replace(/:\d+$/, '');

export async function parse(file) {
  const { records } = readCsv(file, 'Firefox', accepts, 'url, username, password, httpRealm などの');
  const warnings = [];
  let internal = 0;
  const out = collect(records, (r) => {
    const url = pick(r, 'url', 'hostname').trim();
    if (INTERNAL_URL.test(url)) { internal++; return null; }
    const realm = String(r.httprealm ?? '').trim();
    return {
      title: hostText(url),
      url,
      username: r.username,
      password: r.password,
      note: realm ? `HTTP 認証の領域: ${realm}` : '',
      createdAt: toMs(r.timecreated),
      updatedAt: toMs(r.timepasswordchanged),
    };
  }, warnings);
  if (internal) warnings.push(`Firefox の同期用エントリ ${internal} 件は取り込みませんでした`);
  return out;
}
