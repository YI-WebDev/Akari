// Apple Passwords app / Safari CSV: Title,URL,Username,Password,Notes,OTPAuth
// (OTPAuth is an otpauth:// URI; older Safari exports have no Notes column).

import { pick } from '../csv.js';
import { collect, fits, otpOf, readCsv } from './_csv.js';

const SHAPE = { all: ['title', 'url', 'username', 'password'] };
export const accepts = (headers) => fits(headers, SHAPE);

export async function parse(file, ctx = {}) {
  const label = ctx.source === 'safari' ? 'Safari' : 'Apple Passwords';
  const { records } = readCsv(file, label, accepts, 'Title, URL, Username, Password の');
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
