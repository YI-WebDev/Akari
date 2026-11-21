import { matchingLogins } from './autofill-service.js';
import * as vaultService from './vault-service.js';

const MAX_SHOWN = 99;
const BADGE_BACKGROUND = '#1A1511';
const BADGE_TEXT = '#FFFFFF';

export const badgeText = (count) => (count > MAX_SHOWN ? MAX_SHOWN + '+' : count > 0 ? String(count) : '');

export function createBadgeService({ chrome, vault }) {
  let tail = Promise.resolve();
  const enqueue = (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };

  async function unlockedItems() {
    try {
      if (await vault.isLocked()) return null;
      return (await vault.readData()).items;
    } catch {
      return null;
    }
  }

  async function paint(tab, items) {
    if (!tab || !Number.isInteger(tab.id)) return;
    const text = items ? badgeText(matchingLogins(items, tab.url).length) : '';
    try {
      await chrome.action.setBadgeText({ tabId: tab.id, text });
    } catch {
    }
  }

  const refreshTab = (tabId) => enqueue(async () => {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return;
    }
    await paint(tab, await unlockedItems());
  });

  const refreshAll = () => enqueue(async () => {
    let tabs;
    try {
      tabs = await chrome.tabs.query({});
    } catch {
      return;
    }
    const items = await unlockedItems();
    await Promise.all(tabs.map((tab) => paint(tab, items)));
  });

  function install() {
    const quiet = (p) => Promise.resolve(p).catch(() => {});
    try {
      quiet(chrome.action.setBadgeBackgroundColor({ color: BADGE_BACKGROUND }));
      quiet(chrome.action.setBadgeTextColor?.({ color: BADGE_TEXT }));
    } catch {
    }
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.url !== undefined || changeInfo.status !== undefined) quiet(refreshTab(tabId));
    });
    chrome.tabs.onActivated.addListener(({ tabId }) => quiet(refreshTab(tabId)));
    chrome.tabs.onReplaced?.addListener((addedTabId) => quiet(refreshTab(addedTabId)));
    chrome.runtime.onStartup?.addListener(() => quiet(refreshAll()));
    vault.onChanged(() => quiet(refreshAll()));
    quiet(refreshAll());
  }

  return { refreshTab, refreshAll, install };
}

if (globalThis.chrome?.runtime?.id && globalThis.chrome.action) {
  createBadgeService({ chrome, vault: vaultService }).install();
}
