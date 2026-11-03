// Chrome / Brave / Edge CSV: name,url,username,password,note (older exports have no note).

import { collect, fits, readCsv } from './_csv.js';

const SHAPE = { all: ['name', 'url', 'username', 'password'] };
export const accepts = (headers) => fits(headers, SHAPE);

const LABELS = { brave: 'Brave', edge: 'Edge' };

export async function parse(file, ctx = {}) {
  const { records } = readCsv(file, LABELS[ctx.source] || 'Chrome', accepts, 'name, url, username, password の');
  return collect(records, (r) => ({
    title: r.name,
    url: r.url,
    username: r.username,
    password: r.password,
    note: r.note,
  }));
}
