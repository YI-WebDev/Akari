import { pick } from '../csv.js';
import { t } from '../../../shared/i18n.js';
import { collect, fits, otpOf, readCsv } from './_csv.js';

const SHAPE = { all: ['title', 'url', 'username', 'password'] };
export const accepts = (headers) => fits(headers, SHAPE);

export async function parse(file, ctx = {}) {
  const label = ctx.source === 'safari' ? 'Safari' : 'Apple Passwords';
  const { records } = readCsv(file, accepts,
    t('{label} の CSV ではないようです（Title, URL, Username, Password の列が見つかりません）', { label }));
  return collect(records, (r) => {
    const { totp, extra } = otpOf(r.otpauth);
    return {
      title: r.title,
      url: r.url,
      username: r.username,
      password: r.password,
      note: pick(r, 'notes', 'note'),
      extra,
      totp,
    };
  });
}
