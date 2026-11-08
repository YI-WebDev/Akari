import { t } from '../../../shared/i18n.js';
import { collect, fits, readCsv } from './_csv.js';

const SHAPE = { all: ['name', 'url', 'username', 'password'] };
export const accepts = (headers) => fits(headers, SHAPE);

const LABELS = { brave: 'Brave', edge: 'Edge' };

export async function parse(file, ctx = {}) {
  const { records } = readCsv(file, accepts,
    t('{label} の CSV ではないようです（name, url, username, password の列が見つかりません）', { label: LABELS[ctx.source] || 'Chrome' }));
  return collect(records, (r) => ({
    title: r.name,
    url: r.url,
    username: r.username,
    password: r.password,
    note: r.note,
  }));
}
