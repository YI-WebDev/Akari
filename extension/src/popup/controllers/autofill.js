// The current tab: its site (for the search box and new logins), its autofill matches, and the
// fill itself from the 現在のタブ card.

import { MSG } from '../../shared/messages.js';
import { hostnameOf, registrableDomain } from '../../shared/domain.js';
import { t } from '../../shared/i18n.js';
import { S, call, errText, itemById, replaceItem, liveToken, live, setAutofill } from '../state.js';
import { siteOf } from '../views/format.js';
import { toast, toastError } from '../views/toast.js';
import { renderList, setAfState, afCandidate } from '../views/list.js';

export async function activeTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch {
    return null;
  }
}

export const isWebTab = (tab) => /^https?:\/\//i.test(tab?.url || '');

/** The tab's site as a search: its registrable domain, so "accounts.google.com" also finds google.com logins. */
export function siteQueryOf(tab) {
  if (!isWebTab(tab)) return '';
  const host = hostnameOf(tab.url);
  return host ? registrableDomain(host) || host.replace(/^www\./, '') : '';
}

/** Autofill matches for the tab, or null. Does not touch state. */
export async function fetchAutofill(tabP) {
  const tab = await tabP;
  if (!tab?.id || !isWebTab(tab)) return null;
  try {
    const res = await call(MSG.AUTOFILL_MATCHES, { tabId: tab.id });
    if (!res?.items?.length) return null;
    const url = res.url || tab.url;
    return { tabId: tab.id, url, site: siteOf(url), items: res.items, state: 'idle' };
  } catch {
    return null;
  }
}

/** Re-query matches after an edit (a saved URL may now match the tab, or no longer). */
export async function refreshAutofill() {
  const token = liveToken();
  const res = await fetchAutofill(activeTab());
  if (!live(token) || (S.af && S.af.state !== 'idle')) return;
  setAutofill(res);
  renderList();
}

export async function doAutofill() {
  if (!S.af || S.af.state !== 'idle') return;
  // exactly the account the card shows (vault filter applied)
  const target = afCandidate();
  if (!target) return;
  const { tabId, site } = S.af;
  const token = liveToken();
  setAfState('run');
  try {
    const res = await call(MSG.AUTOFILL_FILL, { tabId, itemId: target.id });
    if (!live(token)) return;
    if (!res?.filled) {
      setAfState('idle');
      toastError(t('入力欄が見つかりませんでした'), t('ログインの入力欄が表示されているページで、もう一度押してください'));
      return;
    }
    setAfState('done');
    toast(t('{site} に自動入力しました', { site }), t('ユーザー名とパスワードを入力'));
    const local = itemById(target.id);
    if (local) replaceItem({ ...local, lastUsedAt: Date.now() });
    setTimeout(() => window.close(), 700);
  } catch (e) {
    if (!live(token)) return;
    setAfState('idle');
    toastError(t('自動入力できませんでした'), errText(e));
  }
}
