import { t } from '../../shared/i18n.js';
import { ISSUES, ACTION_ISSUES, passwordAgeDays, passwordSetAt } from '../../lib/health.js';
import { S, emit, healthCounts, issuesOf, reuseOf, inVault, vaultById, strengthOf } from '../state.js';
import { h, clear, icon, syncInert, keepFocus } from './dom.js';
import { tileEl } from './list.js';

const $ = (id) => document.getElementById(id);
const TABS = ['action', ...ISSUES];
const LABELS = {
  action: ['health.action', '要対応'],
  weak: ['health.weak', '弱い'],
  reused: ['health.reused', '使い回し'],
  old: ['health.old', '古い'],
  no2fa: ['health.no2fa', '2FA なし'],
};
const issueLabel = (k) => t(LABELS[k][0], null, LABELS[k][1]);
const isAction = (k) => ACTION_ISSUES.includes(k);

let tab = 'action';
let sel = null;
let rows = [];
let restoreFocus = null;

export const isHealthOpen = () => $('healthSheet').classList.contains('open');

const logins = () => S.items.filter((it) => inVault(it) && it.type === 'login' && it.password);

function inTab(it, k) {
  const list = issuesOf(it);
  return k === 'action' ? list.some(isAction) : list.includes(k);
}

function rowsOf(k) {
  const list = logins().filter((it) => inTab(it, k));
  const title = (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'ja');
  const age = (a, b) => (passwordSetAt(a) ?? Infinity) - (passwordSetAt(b) ?? Infinity);
  switch (k) {
    case 'weak': return list.sort((a, b) => strengthOf(a.password).bits - strengthOf(b.password).bits || title(a, b));
    case 'old': return list.sort((a, b) => age(a, b) || title(a, b));
    case 'no2fa': return list.sort(title);
    case 'reused': {
      list.sort(title);
      const size = new Map();
      const order = new Map();
      for (const it of list) {
        size.set(it.password, (size.get(it.password) || 0) + 1);
        if (!order.has(it.password)) order.set(it.password, order.size);
      }
      return list.sort((a, b) => size.get(b.password) - size.get(a.password) || order.get(a.password) - order.get(b.password) || title(a, b));
    }
    default: {
      const rank = (it) => ACTION_ISSUES.findIndex((x) => issuesOf(it).includes(x));
      return list.sort((a, b) => rank(a) - rank(b) || age(a, b) || title(a, b));
    }
  }
}

function samePassword(it) {
  return S.items.filter((x) => x.id !== it.id && x.type === 'login' && x.password && x.password === it.password);
}

function line(k, it) {
  switch (k) {
    case 'weak': return t('health.lineWeak', { bits: Math.round(strengthOf(it.password).bits) }, '短いか、よく使われる形のパスワードです（{bits} bit）。');
    case 'reused': return t('health.lineReused', { n: reuseOf(it) }, 'ほかの {n} 件のログインでも同じパスワードです。');
    case 'old': {
      const days = passwordAgeDays(it);
      const years = Math.floor(days / 365);
      return years >= 1
        ? t('health.lineOldYears', { n: years }, '最後の変更から {n} 年以上たっています。')
        : t('health.lineOldDays', { n: days }, '最後の変更から {n} 日たっています。');
    }
    case 'no2fa': return t('health.lineNo2fa', null, '認証コード（2FA）もパスキーも未登録です。');
    default: return '';
  }
}

function renderTabs(c) {
  const box = $('hsTabs');
  clear(box);
  for (const k of TABS) {
    const on = k === tab;
    box.append(h('button', {
      class: 'hs-tab' + (c[k] ? '' : ' zero'), type: 'button', role: 'tab', id: 'hs-tab-' + k, dataset: { issue: k },
      'aria-selected': String(on), 'aria-controls': 'hsList', tabindex: on ? '0' : '-1',
      'aria-label': t('health.tab', { issue: issueLabel(k), count: c[k] }, '{issue} {count} 件'),
      onclick: () => setTab(k),
    }, h('span', { class: 'hs-dot', 'aria-hidden': 'true' }), h('span', { class: 'hs-name' }, issueLabel(k)),
    h('span', { class: 'hs-n' }, k === 'action' ? `${c.action}/${c.logins}` : String(c[k]))));
  }
}

function rowEl(it) {
  const list = issuesOf(it);
  const label = list.map(issueLabel).join(t('・'));
  return h('div', {
    class: 'row hs-row', role: 'option', id: 'hs-row-' + it.id, 'aria-selected': String(it.id === sel), dataset: { id: it.id },
    onclick: () => select(it.id, { focusList: true }),
  },
  h('span', { class: 'row-sel' }),
  h('span', { class: 'row-caret', 'aria-hidden': 'true' }, '›'),
  tileEl(it),
  h('span', { class: 'row-text' },
    h('span', { class: 'row-title' }, it.title || t('(無題)')),
    h('span', { class: 'row-user' }, it.username || '')),
  h('span', { class: 'row-flags hz-dots', role: 'img', 'aria-label': label, title: label },
    ...list.map((k) => h('span', { class: 'hz-dot', dataset: { issue: k } }))));
}

function emptyText(c) {
  if (!c.logins) return t('health.emptyNoLogins', null, 'パスワードのあるログインがまだありません');
  if (tab === 'action') return t('health.emptyAction', null, '対応が必要なパスワードはありません');
  return t('health.emptyIssue', { issue: issueLabel(tab) }, '「{issue}」のログインはありません');
}

function renderList(c) {
  const L = $('hsList');
  clear(L);
  if (!rows.length) {
    L.append(h('div', { class: 'hs-empty' }, h('span', { class: 'hs-empty-ico', 'aria-hidden': 'true' }, icon('check', 16)), emptyText(c)));
  } else {
    for (const it of rows) L.append(rowEl(it));
  }
  L.setAttribute('aria-labelledby', 'hs-tab-' + tab);
  L.setAttribute('aria-activedescendant', sel ? 'hs-row-' + sel : '');
}

function renderPane() {
  const P = $('hsPane');
  clear(P);
  const it = rows.find((x) => x.id === sel);
  if (!it) return;
  const list = issuesOf(it);
  const vault = vaultById(it.vault);
  const action = list.some(isAction);
  P.append(h('div', { class: 'hs-head' }, tileEl(it),
    h('div', { class: 'hs-who' },
      h('div', { class: 'hs-title' }, it.title || t('(無題)')),
      h('div', { class: 'hs-user' }, [it.username, vault?.name && `[${vault.name}]`].filter(Boolean).join('  ')))));
  P.append(h('ul', { class: 'hs-issues' + (action ? '' : ' advice'), 'aria-label': t('health.issues', null, '見つかった問題') },
    ...list.map((k) => h('li', { dataset: { issue: k } },
      h('span', { class: 'tag hz', dataset: { issue: k } }, issueLabel(k)),
      h('span', { class: 'hs-text' }, line(k, it))))));
  if (list.includes('reused')) {
    const same = samePassword(it);
    const shown = same.slice(0, 5).map((x) => x.title || t('(無題)'));
    if (same.length > shown.length) shown.push(t('health.more', { n: same.length - shown.length }, 'ほか {n} 件'));
    P.append(h('p', { class: 'hs-same' }, h('span', { class: 'hs-same-k' }, t('health.same', null, '同じパスワード')), shown.join(t('、'))));
  }
  P.append(h('div', { class: 'hs-acts' },
    h('button', { class: 'btn-mini', type: 'button', onclick: () => act('show', it.id) }, t('health.show', null, '詳細を開く')),
    list.includes('no2fa')
      ? h('button', { class: 'btn-mini add-2fa', type: 'button', onclick: () => act('edit', it.id) }, icon('pencil', 11), t('health.add2fa', null, '2FA を追加'))
      : null,
    action ? h('button', { class: 'btn-fix', type: 'button', onclick: () => act('fix', it.id) }, t('health.fix', null, '強化する'), icon('arrowRight', 11, 2.6)) : null));
}

function render() {
  const c = healthCounts();
  const v = vaultById(S.vault);
  $('hsSub').textContent = t('保管庫: {name}', { name: S.vault === 'all' || !v ? t('すべて') : v.name }) + ' · ' + t('health.logins', { n: c.logins }, 'ログイン {n} 件');
  rows = rowsOf(tab);
  if (!rows.some((x) => x.id === sel)) sel = rows[0]?.id ?? null;
  renderTabs(c);
  renderList(c);
  renderPane();
}

function setTab(k, { focusTab = false } = {}) {
  if (!TABS.includes(k)) return;
  tab = k;
  sel = null;
  render();
  $('hsList').scrollTop = 0;
  if (focusTab) $('hs-tab-' + k).focus({ preventScroll: true });
}

function select(id, { focusList = false } = {}) {
  if (!id) return;
  sel = id;
  for (const r of $('hsList').querySelectorAll('.hs-row')) r.setAttribute('aria-selected', String(r.dataset.id === id));
  $('hsList').setAttribute('aria-activedescendant', 'hs-row-' + id);
  $('hs-row-' + id)?.scrollIntoView({ block: 'nearest' });
  renderPane();
  if (focusList) $('hsList').focus({ preventScroll: true });
}

function act(kind, id) {
  closeHealth({ restore: false });
  emit('healthAct', id, kind);
}

function onKeys(e) {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.target.closest('#hsTabs')) {
    const i = TABS.indexOf(tab);
    const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    setTab(TABS[(to + TABS.length) % TABS.length], { focusTab: true });
    return;
  }
  if (e.target !== $('hsList') || !rows.length) return;
  const i = rows.findIndex((x) => x.id === sel);
  const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: rows.length - 1 }[e.key];
  if (to !== undefined) {
    e.preventDefault();
    select(rows[Math.max(0, Math.min(rows.length - 1, to))].id);
  } else if (e.key === 'Enter' && sel) {
    e.preventDefault();
    act('show', sel);
  }
}

export function openHealth() {
  restoreFocus = keepFocus();
  render();
  const sheet = $('healthSheet');
  $('scrim').classList.add('on');
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  $('hsList').scrollTop = 0;
  syncInert();
  setTimeout(() => $('hsList').focus({ preventScroll: true }), 60);
}

export function closeHealth({ restore = true } = {}) {
  const sheet = $('healthSheet');
  if (!sheet.classList.contains('open')) return;
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
  if (!$('genSheet').classList.contains('open') && !$('setSheet').classList.contains('open')) $('scrim').classList.remove('on');
  rows = [];
  for (const id of ['hsTabs', 'hsList', 'hsPane']) clear($(id));
  syncInert();
  if (restore) restoreFocus?.();
  restoreFocus = null;
}

export function initHealth() {
  $('healthSheet').querySelector('[data-close]').addEventListener('click', () => closeHealth());
  $('healthSheet').addEventListener('keydown', onKeys);
}
