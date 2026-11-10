import { MSG, BACKUP_SNOOZE_DAYS } from '../../shared/messages.js';
import { t } from '../../shared/i18n.js';
import { S, call, liveToken, live } from '../state.js';
import { h, clear } from './dom.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);

let seq = 0;
let openBackup = () => {};

const isDue = (st) => !!st && st.due === true;

function titleOf(st) {
  return st.lastAt == null
    ? t('backup.never', null, 'まだバックアップを書き出していません')
    : t('backup.since', { n: st.days }, '最後のバックアップは {n} 日前です');
}

function render(st) {
  const slot = $('backupNote');
  clear(slot);
  if (!isDue(st)) return;
  slot.append(h('div', { class: 'bk' },
    h('p', { class: 'bk-title' }, titleOf(st)),
    h('p', { class: 'bk-why' }, t('backup.why', null, '保管庫はこのブラウザの中だけにあります。壊れたり消えたりしたときのために、暗号化して書き出しておきましょう。')),
    h('div', { class: 'bk-acts' },
      h('button', { class: 'btn-primary btn-sm', type: 'button', onclick: () => openBackup() }, t('backup.now', null, 'バックアップする')),
      h('button', { class: 'btn-text', type: 'button', onclick: snooze }, t('backup.later', null, 'あとで')))));
}

export function initBackup({ open }) {
  openBackup = open;
}

export function resetBackup() {
  seq++;
  clear($('backupNote'));
}

export async function refreshBackup() {
  if (S.phase !== 'main') return;
  const my = ++seq;
  const token = liveToken();
  try {
    const st = await call(MSG.BACKUP_STATUS);
    if (my !== seq || !live(token) || S.phase !== 'main') return;
    render(st);
  } catch {
    if (my === seq) clear($('backupNote'));
  }
}

export function backupDone() {
  seq++;
  clear($('backupNote'));
  refreshBackup();
}

async function snooze() {
  const slot = $('backupNote');
  const hadFocus = slot.contains(document.activeElement);
  const my = ++seq;
  const token = liveToken();
  try {
    const st = await call(MSG.BACKUP_SNOOZE);
    if (my !== seq || !live(token)) return;
    render(st);
    if (!isDue(st)) {
      if (hadFocus) $('list').focus({ preventScroll: true });
      toast(t('backup.snoozed', { days: BACKUP_SNOOZE_DAYS }, '{days} 日後にもう一度お知らせします'));
    }
  } catch {
    if (my === seq) toast(t('backup.snoozeFailed', null, '後回しにできませんでした'), null, 'err');
  }
}
