import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AkariError } from '../../extension/src/shared/errors.js';
import { createBadgeService, badgeText } from '../../extension/src/background/badge.js';
import { createAutofillService } from '../../extension/src/background/autofill-service.js';

const login = (id, url, over = {}) => ({ id, type: 'login', vault: 'personal', title: id, url, username: 'u', password: 'p', ...over });

function makeFakeVault({ locked = false, items = [] } = {}) {
  const state = { locked, items, listeners: [], reads: 0, touches: 0 };
  return {
    state,
    isLocked: async () => state.locked,
    readData: async () => {
      state.reads++;
      if (state.locked) throw new AkariError('LOCKED');
      return structuredClone({ vaults: [], items: state.items });
    },
    mutateData: async (fn) => fn({ items: state.items }),
    touchActivity: () => { state.touches++; },
    onChanged: (cb) => { state.listeners.push(cb); },
    change(patch) {
      Object.assign(state, patch);
      state.listeners.forEach((cb) => cb());
    },
  };
}

function makeFakeChrome(tabs = {}) {
  const event = () => {
    const fns = [];
    return { addListener: (fn) => fns.push(fn), fire: (...a) => fns.forEach((fn) => fn(...a)) };
  };
  const badges = new Map();
  const calls = [];
  const colors = {};
  return {
    tabsById: tabs,
    badges,
    calls,
    colors,
    tabs: {
      get: async (id) => { if (!tabs[id]) throw new Error('No tab with id: ' + id); return { ...tabs[id] }; },
      query: async () => Object.values(tabs).map((t) => ({ ...t })),
      onUpdated: event(),
      onActivated: event(),
      onReplaced: event(),
    },
    runtime: { onStartup: event() },
    action: {
      setBadgeText: async ({ tabId, text }) => {
        if (!Number.isInteger(tabId)) throw new Error('badge text must be set per tab');
        if (!tabs[tabId]) throw new Error('No tab with id: ' + tabId);
        calls.push({ tabId, text });
        badges.set(tabId, text);
      },
      setBadgeBackgroundColor: async ({ color }) => { colors.background = color; },
      setBadgeTextColor: async ({ color }) => { colors.text = color; },
    },
  };
}

const GITHUB = [login('a', 'https://github.com'), login('b', 'https://gist.github.com/x')];

function setup({ items = GITHUB, locked = false, tabs } = {}) {
  const vault = makeFakeVault({ locked, items });
  const chrome = makeFakeChrome(tabs || {
    1: { id: 1, url: 'https://github.com/login' },
    2: { id: 2, url: 'https://example.org/' },
  });
  const svc = createBadgeService({ chrome, vault });
  const settle = async () => {
    await new Promise((r) => setImmediate(r));
    await svc.refreshTab(-1);
  };
  return { svc, vault, chrome, settle };
}

test('badgeText: nothing for zero, the number up to 99, then 99+', () => {
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(1), '1');
  assert.equal(badgeText(99), '99');
  assert.equal(badgeText(100), '99+');
});

test('each tab shows the number of logins saved for its own site', async () => {
  const { svc, chrome } = setup({
    items: [...GITHUB, login('c', 'https://example.org'), { ...login('d', 'https://github.com'), type: 'note' }],
  });
  await svc.refreshAll();
  assert.deepEqual([...chrome.badges], [[1, '2'], [2, '1']]);
});

test('the badge counts exactly what the popup lists for the tab', async () => {
  const items = [
    ...GITHUB,
    login('sub', 'https://alice.github.io'),
    login('http', 'http://github.com'),
    login('evil', 'https://github.com.evil.io'),
    { ...login('card', 'https://github.com'), type: 'card' },
  ];
  const tabs = {
    1: { id: 1, url: 'https://github.com/login' },
    2: { id: 2, url: 'http://github.com/' },
    3: { id: 3, url: 'https://bob.github.io/' },
    4: { id: 4, url: 'http://localhost:8080/' },
  };
  const { svc, chrome, vault } = setup({ items, tabs });
  const autofill = createAutofillService({ chrome, vault });
  await svc.refreshAll();
  for (const id of Object.keys(tabs).map(Number)) {
    const listed = (await autofill.matches({ tabId: id })).items.length;
    assert.equal(chrome.badges.get(id), badgeText(listed), tabs[id].url);
  }
  assert.deepEqual([...chrome.badges.values()], ['3', '1', '', '']);
});

test('no badge when nothing matches or the page is not http(s)', async () => {
  const { svc, chrome } = setup({
    tabs: {
      1: { id: 1, url: 'https://example.org/' },
      2: { id: 2, url: 'chrome://extensions/' },
      3: { id: 3, url: 'about:blank' },
      4: { id: 4, url: 'file:///C:/github.com/index.html' },
      5: { id: 5 },
    },
  });
  await svc.refreshAll();
  assert.deepEqual([...chrome.badges.values()], ['', '', '', '', '']);
});

test('a locked vault shows no badge and its data is not read', async () => {
  const { svc, chrome, vault } = setup({ locked: true });
  await svc.refreshAll();
  await svc.refreshTab(1);
  assert.deepEqual([...chrome.badges], [[1, ''], [2, '']]);
  assert.equal(vault.state.reads, 0);
});

test('install: paints the open tabs and sets the badge colours', async () => {
  const { svc, chrome, settle } = setup();
  svc.install();
  await settle();
  assert.deepEqual([...chrome.badges], [[1, '2'], [2, '']]);
  assert.match(chrome.colors.background, /^#[0-9A-F]{6}$/i);
  assert.match(chrome.colors.text, /^#[0-9A-F]{6}$/i);
});

test('navigation: the tab is recounted for its new URL, other tabs are left alone', async () => {
  const { svc, chrome, settle } = setup();
  svc.install();
  await settle();
  chrome.calls.length = 0;

  chrome.tabsById[2].url = 'https://github.com/settings';
  chrome.tabs.onUpdated.fire(2, { url: 'https://github.com/settings' }, chrome.tabsById[2]);
  await settle();
  assert.deepEqual(chrome.calls, [{ tabId: 2, text: '2' }]);

  chrome.tabsById[1].url = 'https://example.org/';
  chrome.tabs.onUpdated.fire(1, { status: 'loading' }, chrome.tabsById[1]);
  chrome.tabs.onUpdated.fire(1, { status: 'complete' }, chrome.tabsById[1]);
  await settle();
  assert.equal(chrome.badges.get(1), '');
  assert.equal(chrome.badges.get(2), '2');

  chrome.calls.length = 0;
  chrome.tabs.onUpdated.fire(1, { title: 'Example' }, chrome.tabsById[1]);
  chrome.tabs.onUpdated.fire(1, { favIconUrl: 'https://example.org/favicon.ico' }, chrome.tabsById[1]);
  await settle();
  assert.deepEqual(chrome.calls, [], 'title and favicon changes do not repaint');
});

test('switching to a tab, and a replaced tab, are recounted', async () => {
  const { svc, chrome, settle } = setup();
  svc.install();
  await settle();
  chrome.badges.clear();
  chrome.tabs.onActivated.fire({ tabId: 1, windowId: 1 });
  await settle();
  assert.deepEqual([...chrome.badges], [[1, '2']]);

  chrome.tabsById[7] = { id: 7, url: 'https://gist.github.com/' };
  chrome.tabs.onReplaced.fire(7, 2);
  await settle();
  assert.equal(chrome.badges.get(7), '2');
});

test('vault changes repaint every tab: lock clears, unlock restores, add/edit/delete recount', async () => {
  const { svc, chrome, vault, settle } = setup();
  svc.install();
  await settle();

  vault.change({ locked: true });
  await settle();
  assert.deepEqual([...chrome.badges], [[1, ''], [2, '']]);

  vault.change({ locked: false });
  await settle();
  assert.deepEqual([...chrome.badges], [[1, '2'], [2, '']]);

  vault.change({ items: [...GITHUB, login('c', 'https://example.org')] });
  await settle();
  assert.deepEqual([...chrome.badges], [[1, '2'], [2, '1']]);

  vault.change({ items: [login('a', 'https://example.org'), login('c', 'https://example.org')] });
  await settle();
  assert.deepEqual([...chrome.badges], [[1, ''], [2, '2']]);

  vault.change({ items: [] });
  await settle();
  assert.deepEqual([...chrome.badges], [[1, ''], [2, '']]);
});

test('a lock that lands while a count is in flight still ends with no badge', async () => {
  const { svc, chrome, vault, settle } = setup();
  svc.install();
  await settle();
  const slow = vault.readData;
  let release;
  vault.readData = async () => {
    const data = await slow();
    await new Promise((r) => { release = r; });
    return data;
  };
  chrome.tabs.onUpdated.fire(1, { status: 'complete' }, chrome.tabsById[1]);
  await new Promise((r) => setImmediate(r));
  assert.equal(typeof release, 'function', 'the count is waiting on the vault');
  vault.readData = slow;
  vault.change({ locked: true });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(chrome.badges.get(1), '2', 'the lock repaint waits for the count in flight');
  release();
  await settle();
  assert.deepEqual([...chrome.badges], [[1, ''], [2, '']]);
});

test('closed tabs and failing chrome calls are ignored', async () => {
  const { svc, chrome, settle } = setup();
  svc.install();
  await settle();
  chrome.tabs.onUpdated.fire(99, { status: 'complete' });
  chrome.tabs.onActivated.fire({ tabId: 99 });
  await settle();
  assert.equal(chrome.badges.has(99), false);

  chrome.tabs.query = async () => [{ id: 1, url: 'https://github.com/' }, { id: 50, url: 'https://github.com/' }];
  await svc.refreshAll();
  assert.equal(chrome.badges.get(1), '2');
  chrome.tabs.query = async () => { throw new Error('boom'); };
  await svc.refreshAll();
});

test('counting does not count as activity', async () => {
  const { svc, vault, settle } = setup();
  svc.install();
  await settle();
  await svc.refreshTab(1);
  assert.equal(vault.state.touches, 0);
});
