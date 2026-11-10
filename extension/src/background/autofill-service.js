import { register } from './router.js';
import { AkariError } from '../shared/errors.js';
import { ERR, MSG } from '../shared/messages.js';
import { sameSite, hostnameOf } from '../shared/domain.js';
import { setLoginPassword } from '../lib/vault.js';
import { generatePassword } from '../lib/generator.js';
import * as vaultService from './vault-service.js';

const PENDING_TTL_MS = 2 * 60 * 1000;
const MEMORY_TTL_MS = 10 * 60 * 1000;
const MAX_FIELD_LEN = 4096;
const SUGGESTED_LENGTH = 20;
const SUGGESTED_MIN_LENGTH = 8;
const SUGGESTED_MAX_LENGTH = 48;

const isWebUrl = (url) => typeof url === 'string' && /^https?:\/\//i.test(url);
const isLoopback = (host) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

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

const fieldLimit = (v) => (Number.isInteger(v) && v > 0 ? v : null);

export function suggestedLength({ minLength, maxLength } = {}) {
  const shortest = Math.max(SUGGESTED_MIN_LENGTH, fieldLimit(minLength) ?? SUGGESTED_MIN_LENGTH);
  const longest = Math.min(SUGGESTED_MAX_LENGTH, fieldLimit(maxLength) ?? SUGGESTED_MAX_LENGTH);
  if (shortest > longest) return 0;
  return Math.min(longest, Math.max(shortest, SUGGESTED_LENGTH));
}

const byRecent = (a, b) =>
  (b.lastUsedAt || 0) - (a.lastUsedAt || 0) || (b.updatedAt || 0) - (a.updatedAt || 0);

const sameUser = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const localPart = (s) => String(s || '').trim().toLowerCase().split('@')[0];
const likelySameUser = (a, b) => sameUser(a, b)
  || (String(a || '').includes('@') !== String(b || '').includes('@') && !!localPart(a) && localPart(a) === localPart(b));

export function createAutofillService({ chrome, vault, now = Date.now }) {
  const pending = new Map();
  const filledIn = new Map();
  const steppedUser = new Map();

  function recall(map, tabId, tabUrl) {
    const e = map.get(tabId);
    if (!e) return null;
    if (e.expiresAt <= now() || !sameSite(e.url, tabUrl)) {
      map.delete(tabId);
      return null;
    }
    return e;
  }
  const rememberFill = (tabId, itemId, url) => filledIn.set(tabId, { itemId, url, expiresAt: now() + MEMORY_TTL_MS });

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
    }
  }

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

  async function dropPendingIfLocked() {
    const locked = await vault.isLocked();
    if (locked) pending.clear();
    return locked;
  }
  if (typeof vault.onUnlocked === 'function') vault.onUnlocked(() => pending.clear());

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
      origin: new URL(tab.url).origin,
    };
    const opts = { frameId: 0 };
    const attempt = async () => {
      const res = await chrome.tabs.sendMessage(tab.id, payload, opts);
      return !!(res && res.filled);
    };
    try {
      return await attempt();
    } catch {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [0] },
          files: ['src/content/i18n-page.js', 'src/content/shadow-ui.js', 'src/content/autofill.js'],
        });
        return await attempt();
      } catch {
        return false;
      }
    }
  }

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
    if (filled) {
      rememberFill(tab.id, item.id, tab.url);
      await markUsed(item.id);
    }
    return { filled };
  }

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
    rememberFill(sender.tab.id, item.id, tabUrl);
    await markUsed(item.id);
    return { username: item.username || '', password: item.password || '' };
  }

  function noteUsername(msg, sender) {
    const { tabId, tabUrl, frameUrl } = senderPage(sender);
    const username = typeof msg.username === 'string' ? msg.username.trim() : '';
    if (!username || username.length > MAX_FIELD_LEN) throw new AkariError(ERR.INVALID, 'Invalid username');
    if (sameSite(frameUrl, tabUrl)) steppedUser.set(tabId, { username, url: tabUrl, expiresAt: now() + MEMORY_TTL_MS });
    return {};
  }

  async function suggestPassword(msg, sender) {
    senderPage(sender);
    if (sender.frameId !== 0) return { locked: false, password: '' };
    if (await vault.isLocked()) return { locked: true, password: '' };
    const length = suggestedLength(msg);
    return { locked: false, password: length ? generatePassword({ length }).password : '' };
  }

  async function offerSave(msg, sender) {
    const { tabId, tabUrl, frameUrl } = senderPage(sender);
    const username = typeof msg.username === 'string' ? msg.username.trim() : '';
    const password = typeof msg.password === 'string' ? msg.password : '';
    if (!password || password.length > MAX_FIELD_LEN || username.length > MAX_FIELD_LEN) {
      throw new AkariError(ERR.INVALID, 'Invalid credentials');
    }
    if (!sameSite(frameUrl, tabUrl)) return { action: 'none' };
    if (await dropPendingIfLocked()) throw new AkariError(ERR.LOCKED, 'Vault is locked');

    const logins = await loginsFor(tabUrl);
    const user = username || recall(steppedUser, tabId, tabUrl)?.username || '';
    const filledId = recall(filledIn, tabId, tabUrl)?.itemId;
    const filled = (filledId && logins.find((it) => it.id === filledId)) || null;
    const sameAccount = (it) => !user || likelySameUser(it.username, user);

    const alreadySaved = (filled && filled.password === password)
      || logins.some((it) => it.password === password && sameAccount(it));
    if (alreadySaved) {
      pending.delete(tabId);
      return { action: 'none' };
    }
    const filledLoginOfAccount = filled && sameAccount(filled) ? filled : null;
    const loginOfUser = user
      ? logins.find((it) => sameUser(it.username, user)) || logins.find((it) => likelySameUser(it.username, user))
      : null;
    const onlyLogin = !user && logins.length === 1 ? logins[0] : null;
    const target = filledLoginOfAccount || loginOfUser || onlyLogin || null;
    const action = target ? 'update' : 'new';
    const host = hostnameOf(tabUrl);
    pending.set(tabId, {
      action,
      itemId: target ? target.id : undefined,
      username: target ? target.username : user,
      password,
      host,
      origin: originOf(tabUrl),
      expiresAt: now() + PENDING_TTL_MS,
    });
    const out = { action, username: target ? target.username : user, host };
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
          setLoginPassword(existing, p.password, now());
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
            vault: draft.vaults?.[0]?.id ?? 'personal',
          }),
        );
      });
    } catch (e) {
      if (e && e.code === ERR.LOCKED) pending.clear();
      throw e;
    }
    pending.delete(tabId);
    await vault.touchActivity();
    return { saved: true, action: p.action };
  }

  async function onCommand(command) {
    if (command !== 'autofill') return;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || tab.id == null) return;
    if (await vault.isLocked()) {
      try {
        await chrome.action.openPopup();
      } catch {
      }
      return;
    }
    if (!isWebUrl(tab.url)) return;
    const [best] = await loginsFor(tab.url);
    if (best) await fill({ tabId: tab.id, itemId: best.id });
  }

  const forgetTab = (tabId) => {
    pending.delete(tabId);
    filledIn.delete(tabId);
    steppedUser.delete(tabId);
  };

  return { matches, fill, pageMatches, requestFill, noteUsername, suggestPassword, offerSave, confirmSave, onCommand, forgetTab };
}

if (globalThis.chrome?.runtime?.id) {
  const svc = createAutofillService({ chrome, vault: vaultService });

  register(MSG.AUTOFILL_MATCHES, svc.matches, { from: 'extension' });
  register(MSG.AUTOFILL_FILL, svc.fill, { from: 'extension' });
  register(MSG.AUTOFILL_PAGE_MATCHES, svc.pageMatches, { from: 'content' });
  register(MSG.AUTOFILL_REQUEST_FILL, svc.requestFill, { from: 'content' });
  register(MSG.AUTOFILL_NOTE_USERNAME, svc.noteUsername, { from: 'content' });
  register(MSG.AUTOFILL_SUGGEST_PASSWORD, svc.suggestPassword, { from: 'content' });
  register(MSG.AUTOFILL_OFFER_SAVE, svc.offerSave, { from: 'content' });
  register(MSG.AUTOFILL_CONFIRM_SAVE, svc.confirmSave, { from: 'content' });

  chrome.commands.onCommand.addListener((command) => {
    svc.onCommand(command).catch((e) => console.error('[akari] autofill command failed:', e && e.message));
  });
  chrome.tabs.onRemoved.addListener((tabId) => svc.forgetTab(tabId));
}
