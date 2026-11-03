// Fake `chrome` for previewing the popup outside the extension (tests/ui/preview.html,
// tests/ui/screenshot.mjs). Classic script — load it before popup.js.
// Implements the PLAN §3 messages the popup sends, over the design's seed data.
// Config: window.__AKARI_MOCK__ = { state: 'unlocked'|'locked'|'setup', empty, tabUrl, qrDataUrl, delay }
// or the same keys as query parameters of the page URL.
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var cfg = Object.assign({
    state: params.get('state') || 'unlocked',
    empty: params.get('empty') === '1',
    tabUrl: params.get('tab') || 'https://github.com/login',
    delay: params.has('delay') ? Number(params.get('delay')) : 1,
    qrDataUrl: null,
  }, window.__AKARI_MOCK__ || {});
  window.__AKARI_MOCK__ = cfg;

  var DAY = 86400000;
  var HOUR = 3600000;
  var now = Date.now();
  var sod = new Date(now); sod.setHours(0, 0, 0, 0); sod = sod.getTime();
  var today = function (msAgo) { return Math.max(sod + 60000, now - msAgo); };
  var date = function (s) { var p = s.split('/'); return new Date(+p[0], +p[1] - 1, +p[2], 10, 0).getTime(); };
  var morning = new Date(now); morning.setHours(8, 10, 0, 0);
  morning = Math.min(morning.getTime(), now - 5 * 60000);

  function L(id, vault, title, user, pass, hue, x) {
    var it = {
      id: id, type: 'login', vault: vault, title: title, url: 'https://' + title, username: user, password: pass,
      totp: null, note: '', fav: false, hue: hue, passkeys: [],
      createdAt: date('2024/05/02'), updatedAt: date('2025/06/14'), passwordUpdatedAt: date('2025/06/14'), lastUsedAt: null,
    };
    return Object.assign(it, x || {});
  }
  var T = function (secret, issuer, label) { return { secret: secret, algorithm: 'SHA1', digits: 6, period: 30, issuer: issuer, label: label }; };

  // Component.seed() from design/Akari Terminal.dc.html, mapped onto the PLAN §2 item model.
  function seed() {
    return [
      L('github', 'work', 'github.com', 'haruka.dev@gmail.com', 'v8#Lq2!mTz9@rWk4pE', 285, { fav: true, totp: T('JBSWY3DPEHPK3PXP', 'GitHub', 'haruka.dev@gmail.com'), url: 'https://github.com/login', lastUsedAt: today(2 * HOUR), createdAt: date('2023/03/12'), updatedAt: date('2025/09/18') }),
      L('google', 'personal', 'accounts.google.com', 'haruka.sato@gmail.com', 'Sora-Kumo-Hoshi-42', 250, {
        fav: true, totp: T('GEZDGNBVGY3TQOJQ', 'Google', 'haruka.sato@gmail.com'), lastUsedAt: morning, createdAt: date('2019/11/03'), updatedAt: date('2025/04/22'),
        passkeys: [
          { credentialId: 'cred-google-1', rpId: 'google.com', userHandle: 'dXNlcg', userName: 'haruka.sato@gmail.com', userDisplayName: 'Haruka Sato', publicKey: 'pk', alg: -7, signCount: 4, createdAt: date('2025/03/02'), lastUsedAt: now - 3 * DAY },
          { credentialId: 'cred-google-2', rpId: 'accounts.google.com', userHandle: 'dXNlcjI', userName: 'sato.family@gmail.com', userDisplayName: 'Sato Family', publicKey: 'pk', alg: -7, signCount: 0, createdAt: date('2025/08/11'), lastUsedAt: null },
        ],
      }),
      L('claude', 'personal', 'claude.ai', 'haruka.sato@gmail.com', 'c1aude!Notes#88wq', 45, { lastUsedAt: now - DAY, note: 'API キーは「開発メモ」ノートに保存', createdAt: date('2024/08/19'), updatedAt: date('2025/08/19') }),
      L('figma', 'work', 'figma.com', 'haruka@studio-mori.jp', 'Fr4m3s&Vect0rs!', 20, { lastUsedAt: now - 3 * DAY }),
      L('notion', 'work', 'notion.so', 'haruka@studio-mori.jp', 'n0tion-Desk-Lamp-7', 95, { totp: T('KRSXG5CTMVRXEZLU', 'Notion', 'haruka@studio-mori.jp'), lastUsedAt: now - 4 * DAY }),
      L('amazon', 'personal', 'amazon.co.jp', 'haruka.sato@gmail.com', 'amz2024', 70, { lastUsedAt: now - 8 * DAY, createdAt: date('2016/02/14'), updatedAt: date('2018/07/01') }),
      L('mercari', 'personal', 'jp.mercari.com', '080-1234-5678', 'mercari1234', 25, { lastUsedAt: now - 9 * DAY, createdAt: date('2020/01/09'), updatedAt: date('2020/01/09') }),
      L('netflix', 'family', 'netflix.com', 'family@sato-home.jp', 'Popcorn&Kotatsu_31', 15, { lastUsedAt: now - 9 * DAY - 6 * HOUR }),
      L('rakuten', 'personal', 'rakuten.co.jp', 'haruka.sato@gmail.com', 'R@kuten!Ichiba2025', 5, { lastUsedAt: now - 15 * DAY }),
      L('slack', 'work', 'studio-mori.slack.com', 'haruka@studio-mori.jp', 'S1ack#Mori!Team', 330, { totp: T('MFRGGZDFMZTWQ2LK', 'Slack', 'haruka@studio-mori.jp'), lastUsedAt: now - 16 * DAY }),
      L('aws', 'work', 'aws.amazon.com', 'admin@studio-mori.jp', 'X9!vQ#2mL$8wZr&4Tp', 55, { fav: true, totp: T('NBSWY3DPO5XXE3DE', 'AWS', 'admin'), note: 'ルートアカウント。普段は IAM ユーザーでログインする。', lastUsedAt: now - 22 * DAY }),
      L('spotify', 'family', 'spotify.com', 'family@sato-home.jp', 'Hikari-Oto-Ame-88', 150, { lastUsedAt: now - 32 * DAY }),
      L('x', 'personal', 'x.com', '@haruka_mori', 'tw33t#Sakura!', 230, { lastUsedAt: now - 33 * DAY }),
      L('dropbox', 'family', 'dropbox.com', 'family@sato-home.jp', 'Box!Photos#2019', 240, { lastUsedAt: now - 35 * DAY }),
      { id: 'wifi', type: 'note', vault: 'family', title: '自宅の Wi-Fi', url: '', username: '', password: '', totp: null, note: 'SSID: sato-home-5G\nパスワード: kotatsu-mikan-2024\nルーターの管理画面は 192.168.0.1', fav: false, hue: 180, passkeys: [], createdAt: date('2024/12/01'), updatedAt: now - 40 * DAY, passwordUpdatedAt: null, lastUsedAt: null },
    ];
  }

  var db = {
    initialized: cfg.state !== 'setup',
    locked: cfg.state !== 'unlocked',
    master: 'akari-master',
    vaults: [{ id: 'personal', name: '個人', hue: 55 }, { id: 'work', name: '仕事', hue: 255 }, { id: 'family', name: '家族', hue: 150 }],
    items: cfg.empty || cfg.state === 'setup' ? [] : seed(),
    settings: { autoLockMinutes: 15, clipboardClearSeconds: 30 },
  };
  window.__AKARI_DB__ = db;

  function AkErr(code, message) { var e = new Error(message || code); e.code = code; return e; }
  var clone = function (x) { return JSON.parse(JSON.stringify(x)); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms * cfg.delay); }); };
  function needUnlocked() { if (db.locked) throw AkErr('LOCKED', 'Vault is locked'); }
  function hostOf(u) { try { return new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
  function site(host) { var p = host.split('.'); var n = /\.(co|ne|or|ac)\.jp$/.test(host) ? 3 : 2; return p.slice(-n).join('.'); }

  var handlers = {
    'vault/status': function () { return { initialized: db.initialized, locked: db.initialized ? db.locked : true }; },
    'vault/setup': async function (m) {
      if (db.initialized) throw AkErr('ALREADY_INITIALIZED');
      await sleep(900);
      db.initialized = true; db.locked = false; db.master = m.masterPassword; db.items = [];
      return {};
    },
    'vault/unlock': async function (m) {
      await sleep(700);
      if (!m.masterPassword || m.masterPassword === 'wrong') throw AkErr('BAD_PASSWORD', 'Wrong password');
      db.locked = false;
      return {};
    },
    'vault/lock': function () { db.locked = true; return {}; },
    'vault/getAll': async function () { needUnlocked(); await sleep(200); return { vaults: clone(db.vaults), items: clone(db.items) }; },
    'vault/saveItem': async function (m) {
      needUnlocked();
      var it = m.item || {};
      if (it.passkeys) throw AkErr('INVALID', 'popup must not send passkeys');
      await sleep(250);
      var t = Date.now();
      var cur = it.id && db.items.find(function (x) { return x.id === it.id; });
      if (it.id && !cur) throw AkErr('NOT_FOUND');
      if (cur) {
        var pwChanged = 'password' in it && it.password !== cur.password;
        var keep = { passkeys: cur.passkeys, createdAt: cur.createdAt, lastUsedAt: cur.lastUsedAt };
        Object.assign(cur, it, keep, { updatedAt: t });
        if (pwChanged) cur.passwordUpdatedAt = t;
        return { item: clone(cur) };
      }
      var created = Object.assign({ type: 'login', vault: 'personal', title: '', url: '', username: '', password: '', totp: null, note: '', fav: false, hue: Math.floor(Math.random() * 360) },
        it, { id: 'new-' + t.toString(36), passkeys: [], createdAt: t, updatedAt: t, passwordUpdatedAt: it.password ? t : null, lastUsedAt: null });
      db.items.push(created);
      return { item: clone(created) };
    },
    'vault/deleteItem': async function (m) {
      needUnlocked(); await sleep(200);
      var n = db.items.length;
      db.items = db.items.filter(function (x) { return x.id !== m.id; });
      if (db.items.length === n) throw AkErr('NOT_FOUND');
      return {};
    },
    'vault/deletePasskey': async function (m) {
      needUnlocked(); await sleep(200);
      var it = db.items.find(function (x) { return x.id === m.itemId; });
      if (!it) throw AkErr('NOT_FOUND');
      it.passkeys = it.passkeys.filter(function (p) { return p.credentialId !== m.credentialId; });
      return {};
    },
    'vault/changePassword': async function (m) {
      needUnlocked(); await sleep(900);
      if (m.current === 'wrong') throw AkErr('BAD_PASSWORD');
      db.master = m.next;
      return {};
    },
    'vault/export': async function () {
      needUnlocked(); await sleep(150);
      return { json: JSON.stringify({ format: 'akari-backup', version: 1, exportedAt: Date.now(), vault: { version: 1, kdf: { name: 'PBKDF2' }, wrappedKey: {}, data: {} } }) };
    },
    'vault/import': async function (m) {
      needUnlocked(); await sleep(800);
      if (m.masterPassword === 'wrong') throw AkErr('BAD_PASSWORD');
      var t = Date.now();
      db.items.push(L('imp1-' + t, 'personal', 'booking.com', 'haruka.sato@gmail.com', 'Tabi!Kyoto#2026', 200, { createdAt: t, updatedAt: t }));
      db.items.push(L('imp2-' + t, 'work', 'linear.app', 'haruka@studio-mori.jp', 'L1near-Issue-Board', 260, { createdAt: t, updatedAt: t }));
      return { count: 2 };
    },
    'settings/get': function () { return clone(db.settings); },
    'settings/set': function (m) { Object.assign(db.settings, m.patch || {}); return clone(db.settings); },
    'clipboard/scheduleClear': function (m) { console.log('[mock] clipboard clear in', m.seconds, 's'); return {}; },
    'activity/ping': function () { needUnlocked(); return {}; },
    'autofill/matches': async function () {
      needUnlocked();
      var tabSite = site(hostOf(cfg.tabUrl));
      var items = db.items.filter(function (x) { return x.type === 'login' && x.url && site(hostOf(x.url)) === tabSite; })
        .map(function (x) { return { id: x.id, title: x.title, username: x.username, hue: x.hue }; });
      return { url: cfg.tabUrl, items: items };
    },
    'autofill/fill': async function (m) {
      needUnlocked(); await sleep(500);
      var it = db.items.find(function (x) { return x.id === m.itemId; });
      if (!it) throw AkErr('NOT_FOUND');
      it.lastUsedAt = Date.now();
      return { filled: true };
    },
  };

  async function sendMessage(msg) {
    var h = handlers[msg && msg.type];
    if (!h) return { ok: false, error: { code: 'INTERNAL', message: 'mock: no handler for ' + (msg && msg.type) } };
    try {
      var data = await h(msg);
      return { ok: true, data: data || {} };
    } catch (e) {
      return { ok: false, error: { code: e.code || 'INTERNAL', message: e.message } };
    }
  }

  var store = function () {
    var mem = {};
    return {
      get: async function (keys) {
        if (keys == null) return clone(mem);
        var out = {};
        [].concat(keys).forEach(function (k) { if (k in mem) out[k] = mem[k]; });
        return out;
      },
      set: async function (obj) { Object.assign(mem, clone(obj)); },
      remove: async function (keys) { [].concat(keys).forEach(function (k) { delete mem[k]; }); },
      setAccessLevel: async function () {},
    };
  };

  var BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

  var chromeMock = {
    runtime: {
      id: 'akari-mock',
      sendMessage: sendMessage,
      getManifest: function () { return { name: 'Akari', version: '0.1.0', manifest_version: 3 }; },
      getURL: function (p) { return location.origin + '/extension/' + String(p || '').replace(/^\//, ''); },
      onMessage: { addListener: function () {}, removeListener: function () {} },
      lastError: undefined,
    },
    tabs: {
      query: async function () { return [{ id: 7, windowId: 1, active: true, url: cfg.tabUrl, title: hostOf(cfg.tabUrl) }]; },
      create: async function (o) { console.log('[mock] tabs.create', o && o.url); return { id: 99, url: o && o.url }; },
      captureVisibleTab: async function () { return cfg.qrDataUrl || BLANK_PNG; },
    },
    storage: { local: store(), session: store(), onChanged: { addListener: function () {} } },
  };

  try {
    Object.defineProperty(window, 'chrome', { value: chromeMock, configurable: true, writable: true });
  } catch (e) {
    window.chrome = chromeMock;
  }
  // window.close() would end the preview; log instead.
  window.close = function () { console.log('[mock] window.close()'); };
})();
