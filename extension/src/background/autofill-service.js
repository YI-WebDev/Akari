// Autofill: matches saved logins to a tab, fills on explicit request, and runs the
// "save / update this password" prompt. Origins are always judged from sender.url /
// sender.tab.url / chrome.tabs.get — never from anything the page or popup sends.

import { register, AkariError } from './router.js';
import { ERR, MSG } from '../shared/messages.js';
import { sameSite, hostnameOf } from '../shared/domain.js';
import * as vaultService from './vault-service.js';

const PENDING_TTL_MS = 2 * 60 * 1000;
const MAX_FIELD_LEN = 4096;

const isWebUrl = (url) => typeof url === 'string' && /^https?:\/\//i.test(url);
const isLoopback = (host) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

/**
 * Same site (registrable domain) as the saved URL, and never an https → http downgrade
 * (a password saved for https must not be handed to a plaintext page).
 */
export function urlMatches(itemUrl, pageUrl) {
  if (!isWebUrl(pageUrl) || !sameSite(itemUrl, pageUrl)) return false;
  if (/^https:\/\//i.test(itemUrl) && /^http:\/\//i.test(pageUrl) && !isLoopback(hostnameOf(pageUrl))) return false;
  return true;
}

const summarize = (it) => ({
  id: it.id,
  title: it.title || hostnameOf(it.url) || '',
  username: it.username || '',
  hue: Number.isFinite(it.hue) ? it.hue : 0,
});

const byRecent = (a, b) =>
  (b.lastUsedAt || 0) - (a.lastUsedAt || 0) || (b.updatedAt || 0) - (a.updatedAt || 0);

const sameUser = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * @param {{ chrome: typeof globalThis.chrome, vault: object, now?: () => number }} deps
 *   vault = the vault-service API from PLAN.md §3.1 (isLocked, readData, mutateData, touchActivity, makeItem).
 */
export function createAutofillService({ chrome, vault, now = Date.now }) {
  /** tabId -> { action, itemId, username, password, host, origin, expiresAt } (SW memory only) */
  const pending = new Map();

  async function requireUnlocked() {
    if (await vault.isLocked()) throw new AkariError(ERR.LOCKED, 'Vault is locked');
  }

  async function getTab(tabId) {
    if (!Number.isInteger(tabId)) throw new AkariError(ERR.INVALID, 'tabId is required');
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      throw new AkariError(ERR.NOT_FOUND, 'Tab not found');
    }
  }

  /** Logins whose saved URL matches every given page URL, most recently used first. */
  async function loginsFor(...pageUrls) {
    const data = await vault.readData();
    return data.items
      .filter((it) => it.type === 'login' && pageUrls.every((u) => urlMatches(it.url, u)))
      .sort(byRecent);
  }

  async function findLogin(itemId) {
    const data = await vault.readData();
    const item = data.items.find((it) => it.type === 'login' && it.id === itemId);
    if (!item) throw new AkariError(ERR.NOT_FOUND, 'Item not found');
    return item;
  }

  async function markUsed(itemId) {
    try {
      await vault.mutateData((draft) => {
        const it = draft.items.find((i) => i.id === itemId);
        if (it) it.lastUsedAt = now();
      });
    } catch {
      // Usage stats are best effort (e.g. the vault auto-locked meanwhile).
    }
  }

  // Content-script senders: both the frame and the top document must be web pages.
  function senderPage(sender) {
    const tab = sender.tab;
    if (!tab || !isWebUrl(sender.url) || !isWebUrl(tab.url)) {
      throw new AkariError(ERR.FORBIDDEN, 'Not a web page');
    }
    return { tabId: tab.id, tabUrl: tab.url, frameUrl: sender.url };
  }

  const originOf = (url) => {
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  };

  // Candidates hold a plaintext password, so they must not outlive the unlocked session. vault-service has
  // no "locked" event: drop everything whenever an access sees the vault locked, and on every unlock.
  async function dropPendingIfLocked() {
    const locked = await vault.isLocked();
    if (locked) pending.clear();
    return locked;
  }
  if (typeof vault.onUnlocked === 'function') vault.onUnlocked(() => pending.clear());

  /** The tab's pending candidate, only while fresh and only on the origin where it was captured. */
  function livePending(tabId, tabUrl) {
    const p = pending.get(tabId);
    if (!p) return null;
    if (p.expiresAt <= now()) {
      pending.delete(tabId);
      return null;
    }
    return p.origin === originOf(tabUrl) ? p : null;
  }

  async function deliver(tab, item) {
    const payload = {
      type: MSG.AUTOFILL_DO_FILL,
      username: item.username || '',
      password: item.password || '',
      origin: new URL(tab.url).origin, // lets the content script refuse if the tab navigated meanwhile
    };
    const opts = { frameId: 0 };
    const attempt = async () => {
      const res = await chrome.tabs.sendMessage(tab.id, payload, opts);
      return !!(res && res.filled);
    };
    try {
      return await attempt();
    } catch {
      // Tab predates the extension (or its content script was invalidated): inject once and retry.
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [0] },
          files: ['src/content/autofill.js'],
        });
        return await attempt();
      } catch {
        return false;
      }
    }
  }

  // ---- from: extension (popup) ------------------------------------------------

  async function matches(msg) {
    const tab = await getTab(msg.tabId);
    await requireUnlocked();
    const items = isWebUrl(tab.url) ? await loginsFor(tab.url) : [];
    return { url: tab.url || '', items: items.map(summarize) };
  }

  async function fill(msg) {
    const tab = await getTab(msg.tabId);
    await requireUnlocked();
    const item = await findLogin(msg.itemId);
    if (!urlMatches(item.url, tab.url)) {
      throw new AkariError(ERR.DOMAIN_MISMATCH, 'This login belongs to a different site');
    }
    await vault.touchActivity();
    const filled = await deliver(tab, item);
    if (filled) await markUsed(item.id);
    return { filled };
  }

  // ---- from: content ----------------------------------------------------------

  async function pageMatches(msg, sender) {
    const { tabId, tabUrl, frameUrl } = senderPage(sender);
    const locked = await dropPendingIfLocked();
    const items = locked ? [] : (await loginsFor(frameUrl, tabUrl)).map(summarize);
    const out = { locked, items };
    const p = sender.frameId === 0 ? livePending(tabId, tabUrl) : null;
    if (p) out.pendingSave = { action: p.action, username: p.username, host: p.host };
    return out;
  }

  async function requestFill(msg, sender) {
    const { tabUrl, frameUrl } = senderPage(sender);
    await requireUnlocked();
    const item = await findLogin(msg.itemId);
    if (!urlMatches(item.url, frameUrl) || !urlMatches(item.url, tabUrl)) {
      throw new AkariError(ERR.DOMAIN_MISMATCH, 'This login belongs to a different site');
    }
    await vault.touchActivity();
    await markUsed(item.id);
    return { username: item.username || '', password: item.password || '' };
  }

  async function offerSave(msg, sender) {
    const { tabId, tabUrl, frameUrl } = senderPage(sender);
    const username = typeof msg.username === 'string' ? msg.username.trim() : '';
    const password = typeof msg.password === 'string' ? msg.password : '';
    if (!password || password.length > MAX_FIELD_LEN || username.length > MAX_FIELD_LEN) {
      throw new AkariError(ERR.INVALID, 'Invalid credentials');
    }
    // A login form embedded from another site must not be saved as a login for this site.
    if (!sameSite(frameUrl, tabUrl)) return { action: 'none' };
    if (await dropPendingIfLocked()) throw new AkariError(ERR.LOCKED, 'Vault is locked');

    const logins = await loginsFor(tabUrl);
    // Password-only forms (e.g. "change password") are matched to the site's only login.
    const candidates = username ? logins.filter((it) => sameUser(it.username, username)) : logins.length === 1 ? logins : [];

    if (candidates.some((it) => it.password === password)) {
      pending.delete(tabId);
      return { action: 'none' };
    }
    const target = candidates[0] || null;
    const action = target ? 'update' : 'new';
    const host = hostnameOf(tabUrl);
    pending.set(tabId, {
      action,
      itemId: target ? target.id : undefined,
      username: target ? target.username : username,
      password,
      host,
      origin: originOf(tabUrl),
      expiresAt: now() + PENDING_TTL_MS,
    });
    const out = { action, username: target ? target.username : username, host };
    if (target) out.itemId = target.id;
    return out;
  }

  async function confirmSave(msg, sender) {
    const { tabId, tabUrl } = senderPage(sender);
    if (sender.frameId !== 0) throw new AkariError(ERR.FORBIDDEN, 'Only the top frame can confirm');
    if (msg.decision !== 'save' && msg.decision !== 'dismiss') {
      throw new AkariError(ERR.INVALID, 'decision must be "save" or "dismiss"');
    }
    const p = livePending(tabId, tabUrl);
    if (!p) return { saved: false };
    if (msg.decision === 'dismiss') {
      pending.delete(tabId);
      return { saved: false };
    }
    if (await dropPendingIfLocked()) throw new AkariError(ERR.LOCKED, 'Vault is locked');

    try {
      await vault.mutateData((draft) => {
        const existing = p.action === 'update' ? draft.items.find((i) => i.id === p.itemId && i.type === 'login') : null;
        if (existing) {
          existing.password = p.password;
          existing.passwordUpdatedAt = now();
          existing.updatedAt = now();
          return;
        }
        draft.items.push(
          vault.makeItem({
            type: 'login',
            title: p.host,
            url: p.origin,
            username: p.username,
            password: p.password,
            vault: 'personal',
          }),
        );
      });
    } catch (e) {
      if (e && e.code === ERR.LOCKED) pending.clear(); // locked between the check and the write
      throw e;
    }
    pending.delete(tabId);
    await vault.touchActivity();
    return { saved: true, action: p.action };
  }

  // ---- keyboard shortcut ------------------------------------------------------

  async function onCommand(command) {
    if (command !== 'autofill') return;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || tab.id == null) return;
    if (await vault.isLocked()) {
      try {
        await chrome.action.openPopup();
      } catch {
        // openPopup needs a focused browser window; the toolbar icon still works.
      }
      return;
    }
    if (!isWebUrl(tab.url)) return;
    const [best] = await loginsFor(tab.url);
    if (best) await fill({ tabId: tab.id, itemId: best.id });
  }

  const forgetTab = (tabId) => pending.delete(tabId);

  return { matches, fill, pageMatches, requestFill, offerSave, confirmSave, onCommand, forgetTab };
}

// Real instance. Skipped outside an extension context so the module can be imported by unit tests.
if (globalThis.chrome?.runtime?.id) {
  const svc = createAutofillService({ chrome, vault: vaultService });

  register(MSG.AUTOFILL_MATCHES, svc.matches, { from: 'extension' });
  register(MSG.AUTOFILL_FILL, svc.fill, { from: 'extension' });
  register(MSG.AUTOFILL_PAGE_MATCHES, svc.pageMatches, { from: 'content' });
  register(MSG.AUTOFILL_REQUEST_FILL, svc.requestFill, { from: 'content' });
  register(MSG.AUTOFILL_OFFER_SAVE, svc.offerSave, { from: 'content' });
  register(MSG.AUTOFILL_CONFIRM_SAVE, svc.confirmSave, { from: 'content' });

  chrome.commands.onCommand.addListener((command) => {
    svc.onCommand(command).catch((e) => console.error('[akari] autofill command failed:', e && e.message));
  });
  chrome.tabs.onRemoved.addListener((tabId) => svc.forgetTab(tabId));
}
