(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var cfg = Object.assign({
    state: params.get('state') || 'unlocked',
    empty: params.get('empty') === '1',
    tabUrl: params.get('tab') || 'https://github.com/login',
    delay: params.has('delay') ? Number(params.get('delay')) : 1,
    lang: params.get('lang') || 'auto',
    uiLang: params.get('uiLang') || 'ja',
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
  function X(id, type, vault, title, hue, fields, x) {
    return Object.assign({
      id: id, type: type, vault: vault, title: title, note: '', fav: false, hue: hue, fields: fields, extra: [],
      createdAt: date('2025/02/10'), updatedAt: date('2025/10/02'), lastUsedAt: null,
    }, x || {});
  }
  var TYPE_IDS = ['login', 'note', 'card', 'identity', 'apiCredential', 'database', 'server', 'softwareLicense', 'sshKey', 'wifi',
    'bankAccount', 'cryptoWallet', 'driverLicense', 'medicalRecord', 'membership', 'passport', 'rewardProgram', 'socialSecurity'];
  var SSH_PRIVATE = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
    'QyNTUxOQAAACDk2Ld0ZXN0LWtleS1mb3ItYWthcmktc2NyZWVuc2hvdHMAAAAAAAAAAAAA',
    'AJgQe8VbEHvFWwAAAAtzc2gtZWQyNTUxOQAAACDk2Ld0ZXN0LWtleS1mb3ItYWthcmktc2',
    'NyZWVuc2hvdHMAAAAAAAAAAAAAAEBkdW1teS1wcml2YXRlLWtleS1ub3QtYS1yZWFsLWtl',
    'eQAAAA9oYXJ1a2FAbW9yaS1tYnABAgMEBQ==',
    '-----END OPENSSH PRIVATE KEY-----',
    '',
  ].join('\n');

  function seed() {
    return [
      L('github', 'work', 'github.com', 'haruka.dev@example.com', 'v8#Lq2!mTz9@rWk4pE', 285, { fav: true, totp: T('JBSWY3DPEHPK3PXP', 'GitHub', 'haruka.dev@example.com'), url: 'https://github.com/login', lastUsedAt: today(2 * HOUR), createdAt: date('2023/03/12'), updatedAt: date('2025/09/18') }),
      L('google', 'personal', 'accounts.google.com', 'haruka.sato@example.com', 'Sora-Kumo-Hoshi-42', 250, {
        fav: true, totp: T('GEZDGNBVGY3TQOJQ', 'Google', 'haruka.sato@example.com'), lastUsedAt: morning, createdAt: date('2019/11/03'), updatedAt: date('2025/04/22'),
        passkeys: [
          { credentialId: 'cred-google-1', rpId: 'google.com', userHandle: 'dXNlcg', userName: 'haruka.sato@example.com', userDisplayName: 'Haruka Sato', publicKey: 'pk', alg: -7, signCount: 4, createdAt: date('2025/03/02'), lastUsedAt: now - 3 * DAY },
          { credentialId: 'cred-google-2', rpId: 'accounts.google.com', userHandle: 'dXNlcjI', userName: 'sato.family@example.com', userDisplayName: 'Sato Family', publicKey: 'pk', alg: -7, signCount: 0, createdAt: date('2025/08/11'), lastUsedAt: null },
        ],
      }),
      L('claude', 'personal', 'claude.ai', 'haruka.sato@example.com', 'c1aude!Notes#88wq', 45, { lastUsedAt: now - DAY, note: 'API キーは「開発メモ」ノートに保存', createdAt: date('2024/08/19'), updatedAt: date('2025/08/19') }),
      L('figma', 'work', 'figma.com', 'haruka@studio-mori.jp', 'Fr4m3s&Vect0rs!', 20, { lastUsedAt: now - 3 * DAY }),
      L('notion', 'work', 'notion.so', 'haruka@studio-mori.jp', 'n0tion-Desk-Lamp-7', 95, { totp: T('KRSXG5CTMVRXEZLU', 'Notion', 'haruka@studio-mori.jp'), lastUsedAt: now - 4 * DAY }),
      L('amazon', 'personal', 'amazon.co.jp', 'haruka.sato@example.com', 'amz2024', 70, { lastUsedAt: now - 8 * DAY, createdAt: date('2016/02/14'), updatedAt: date('2018/07/01'),
        passwordHistory: [{ password: 'amazon2016', changedAt: date('2018/07/01') }, { password: 'Hanako-0214', changedAt: date('2017/03/09') }] }),
      L('mercari', 'personal', 'jp.mercari.com', '080-1234-5678', 'mercari1234', 25, { lastUsedAt: now - 9 * DAY, createdAt: date('2020/01/09'), updatedAt: date('2020/01/09') }),
      L('netflix', 'family', 'netflix.com', 'family@sato-home.jp', 'Popcorn&Kotatsu_31', 15, { lastUsedAt: now - 9 * DAY - 6 * HOUR }),
      L('rakuten', 'personal', 'rakuten.co.jp', 'haruka.sato@example.com', 'R@kuten!Ichiba2025', 5, { lastUsedAt: now - 15 * DAY }),
      L('slack', 'work', 'studio-mori.slack.com', 'haruka@studio-mori.jp', 'S1ack#Mori!Team', 330, { totp: T('MFRGGZDFMZTWQ2LK', 'Slack', 'haruka@studio-mori.jp'), lastUsedAt: now - 16 * DAY }),
      L('aws', 'work', 'aws.amazon.com', 'admin@studio-mori.jp', 'X9!vQ#2mL$8wZr&4Tp', 55, { fav: true, totp: T('NBSWY3DPO5XXE3DE', 'AWS', 'admin'), note: 'ルートアカウント。普段は IAM ユーザーでログインする。', lastUsedAt: now - 22 * DAY,
        extra: [{ label: 'アカウント ID', value: '1234-5678-9012', secret: false }, { label: 'MFA 復旧コード', value: '7KQ2-M9XP-4RTV', secret: true }] }),
      L('spotify', 'family', 'spotify.com', 'family@sato-home.jp', 'Hikari-Oto-Ame-88', 150, { lastUsedAt: now - 32 * DAY }),
      L('x', 'personal', 'x.com', '@haruka_mori', 'tw33t#Sakura!', 230, { lastUsedAt: now - 33 * DAY }),
      L('dropbox', 'family', 'dropbox.com', 'family@sato-home.jp', 'Box!Photos#2019', 240, { lastUsedAt: now - 35 * DAY }),
      { id: 'wifi', type: 'note', vault: 'family', title: '自宅の Wi-Fi', url: '', username: '', password: '', totp: null, note: 'SSID: sato-home-5G\nパスワード: kotatsu-mikan-2024\nルーターの管理画面は 192.168.0.1', fav: false, hue: 180, passkeys: [], createdAt: date('2024/12/01'), updatedAt: now - 40 * DAY, passwordUpdatedAt: null, lastUsedAt: null },

      X('card-jcb', 'card', 'personal', 'JCB カード W', 160, {
        cardholder: 'HARUKA SATO', number: '3540618291742302', expiry: '2029-08', cvv: '418', pin: '2580',
      }, {
        fav: true, lastUsedAt: now - 2 * DAY - 3 * HOUR, note: 'Amazon と楽天の支払い用。ポイントは Oki Doki ポイント。',
        extra: [{ label: 'カード会社 電話', value: '0120-123-456', secret: false }, { label: 'ネット会員 ID', value: 'haruka-sato-jcb', secret: false }],
      }),
      X('card-visa-old', 'card', 'personal', '三井住友カード（旧）', 215, {
        cardholder: 'HARUKA SATO', number: '4980123456789011', expiry: '2025-03', cvv: '902', pin: '',
      }, { note: '更新前のカード。2025 年 3 月で期限切れ。' }),
      X('identity-home', 'identity', 'personal', '佐藤 遥', 200, {
        fullName: '佐藤 遥', lastName: '佐藤', firstName: '遥', middleName: '', email: 'haruka.sato@example.com', phone: '090-1234-5678',
        birthDate: '1992-04-18', company: 'スタジオ森', jobTitle: 'デザイナー', postalCode: '150-0001', country: '日本',
        state: '東京都', city: '渋谷区', address1: '神宮前 3-14-5', address2: 'メゾン原宿 402', website: 'https://haruka.studio-mori.jp',
      }),
      X('api-sakura', 'apiCredential', 'work', 'さくらのクラウド API', 330, {
        host: 'secure.sakura.ad.jp', keyId: 'a7c3e1f2-58b4-4d0e-9a61-3f2c8b7d5e90', secret: 'Zt8qW3nLx5vR2pK9sYb4mJ7cH6fD1gA0', expiry: '2027-03-31',
      }, { note: 'ゾーン tk1a 用。Terraform から使う。' }),
      X('db-prod', 'database', 'work', '本番 PostgreSQL', 230, {
        dbType: 'PostgreSQL 16', host: 'db.studio-mori.internal', port: '5432', database: 'mori_prod', username: 'app_admin', password: 'Pg!Mori-Prod-2026#x',
      }, { extra: [{ label: 'SSL モード', value: 'verify-full', secret: false }, { label: '読み取り専用ユーザー', value: 'ro_report / Ro#Report-88', secret: true }] }),
      X('srv-vps', 'server', 'work', 'さくらの VPS', 120, {
        host: '203.0.113.24', port: '22', username: 'deploy', password: 'Vps#Deploy-2026!q', url: 'https://secure.sakura.ad.jp/vps/',
      }),
      X('lic-affinity', 'softwareLicense', 'personal', 'Affinity Designer 2', 300, {
        product: 'Affinity Designer', version: '2.5', licenseKey: 'AFD2-7KQ9-M3XP-8RTV-WN42', licensee: '佐藤 遥', email: 'haruka.sato@example.com',
        purchaseDate: '2024-11-29', expiry: '', url: 'https://affinity.serif.com',
      }),
      X('ssh-deploy', 'sshKey', 'work', 'デプロイ鍵（ed25519）', 90, {
        privateKey: SSH_PRIVATE,
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOTYt3Rlc3Qta2V5LWZvci1ha2FyaS1zY3JlZW5zaG90cw haruka@mori-mbp',
        fingerprint: 'SHA256:q7Lw0mH3sVt9yXcB2nRk5aE8uJpF1dGz4oQiW6eYxTs', passphrase: 'hotaru-yuki-kaze-07', host: '203.0.113.24', username: 'deploy',
      }, { lastUsedAt: now - 4 * DAY - 2 * HOUR }),
      X('wifi-office', 'wifi', 'work', 'オフィスの Wi-Fi', 175, {
        ssid: 'StudioMori-5G', password: 'kinoko-takenoko-2026', security: 'wpa3',
      }, { lastUsedAt: now - 5 * DAY, note: 'ゲスト用は StudioMori-Guest（パスワードは受付に掲示）' }),
      X('bank-mufg', 'bankAccount', 'personal', '三菱UFJ銀行（給与口座）', 0, {
        bankName: '三菱UFJ銀行', branch: '渋谷支店', accountType: '普通', accountNumber: '1234567', accountHolder: 'サトウ ハルカ',
        routingNumber: '135', swift: 'BOTKJPJT', iban: '', pin: '4821',
      }, { note: 'ネットバンキングの契約番号は別のノートに。' }),
      X('crypto-eth', 'cryptoWallet', 'personal', 'MetaMask（メイン）', 275, {
        network: 'Ethereum', address: '0x52908400098527886E0F7030069857D2E4169EE7',
        recoveryPhrase: 'river amber glow lantern quiet harbor\nmaple twelve orbit candle velvet frost',
        privateKey: '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318', password: 'Mm!Wallet-Hikari-26',
      }),
      X('dl', 'driverLicense', 'personal', '運転免許証', 40, {
        fullName: '佐藤 遥', number: '301234567890', licenseClass: '普通・準中型', birthDate: '1992-04-18', issuedOn: '2023-05-10',
        expiry: '2028-05-18', issuer: '東京都公安委員会', address: '東京都渋谷区神宮前 3-14-5',
      }),
      X('med', 'medicalRecord', 'family', 'かかりつけ医', 140, {
        patientName: '佐藤 遥', provider: '神宮前クリニック', recordNumber: '00428157', doctor: '山田 太郎 先生', insurer: '関東 IT ソフトウェア健康保険組合', policyNumber: '記号 1234 番号 567',
        bloodType: 'A 型 Rh+', allergies: 'スギ花粉\nペニシリン系の抗生物質', medications: 'アレグラ 60mg（朝・晩）',
      }),
      X('mem-jaf', 'membership', 'family', 'JAF 会員証', 60, {
        organization: 'JAF（日本自動車連盟）', memberName: '佐藤 遥', memberId: '1234-5678-90', since: '2019-04-01', expiry: '2027-03-31',
        pin: '', url: 'https://jaf.or.jp',
      }),
      X('passport', 'passport', 'personal', 'パスポート', 10, {
        fullName: 'SATO HARUKA', number: 'TR1234567', nationality: '日本', issuingCountry: '日本', birthDate: '1992-04-18',
        issuedOn: '2016-12-20', expiry: new Date(now + 47 * DAY).toISOString().slice(0, 10), authority: '外務省',
      }, { note: '更新は有効期限の 1 年前から。' }),
      X('reward-ana', 'rewardProgram', 'personal', 'ANA マイレージクラブ', 225, {
        company: 'ANA', memberName: 'SATO HARUKA', memberId: '4123456789', pin: '0418', expiry: '2027-12-31', url: 'https://www.ana.co.jp/ja/jp/amc/',
      }),
      X('ssn', 'socialSecurity', 'personal', 'マイナンバー', 345, { fullName: '佐藤 遥', number: '123456789012' }),
    ];
  }

  var db = {
    initialized: cfg.state !== 'setup',
    locked: cfg.state !== 'unlocked',
    master: 'akari-master',
    vaults: [{ id: 'personal', name: '個人', hue: 55 }, { id: 'work', name: '仕事', hue: 255 }, { id: 'family', name: '家族', hue: 150 }],
    items: cfg.empty || cfg.state === 'setup' ? [] : seed(),
    trash: [],
    settings: { autoLockMinutes: 15, clipboardClearSeconds: 30, language: cfg.lang, theme: cfg.theme || 'dark' },
    backup: { lastAt: null, since: now, snoozedUntil: 0, snoozes: 0 },
  };
  if (cfg.backup) {
    db.backup.lastAt = cfg.backup.lastAt == null ? null : cfg.backup.lastAt;
    db.backup.since = cfg.backup.since == null ? now : cfg.backup.since;
  }
  Object.keys(cfg.seedPatch || {}).forEach(function (id) {
    var it = db.items.find(function (x) { return x.id === id; });
    if (!it) return;
    var p = cfg.seedPatch[id];
    Object.assign(it, p, p.fields ? { fields: Object.assign({}, it.fields, p.fields) } : {});
  });
  window.__AKARI_DB__ = db;

  function backupStatus() {
    var b = db.backup;
    var t = Date.now();
    var days = Math.max(0, Math.floor((t - (b.lastAt == null ? b.since : b.lastAt)) / DAY));
    return { lastAt: b.lastAt, days: days, due: days >= 30 && t >= b.snoozedUntil };
  }
  function resetBackupClock() {
    db.backup.lastAt = Date.now();
    db.backup.snoozedUntil = 0;
  }

  function AkErr(code, message) { var e = new Error(message || code); e.code = code; return e; }
  var clone = function (x) { return JSON.parse(JSON.stringify(x)); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms * cfg.delay); }); };
  function needUnlocked() { if (db.locked) throw AkErr('LOCKED', 'Vault is locked'); }
  function toTrash(ids) {
    var gone = {};
    ids.forEach(function (id) { gone[id] = true; });
    var moved = db.items.filter(function (x) { return gone[x.id]; });
    db.items = db.items.filter(function (x) { return !gone[x.id]; });
    var t = Date.now();
    db.trash = moved.map(function (x) { return Object.assign({}, x, { deletedAt: t }); }).concat(db.trash);
    return moved.map(function (x) { return x.id; });
  }
  function vaultName(name, exceptId) {
    var v = typeof name === 'string' ? name.trim() : '';
    var key = function (s) { return s.normalize('NFKC').toLowerCase(); };
    if (!v || Array.from(v).length > 40) throw AkErr('INVALID', 'Invalid vault name');
    if (db.vaults.some(function (x) { return x.id !== exceptId && key(x.name) === key(v); })) throw AkErr('INVALID', 'Duplicate vault name');
    return v;
  }
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
    'vault/getAll': async function () { needUnlocked(); await sleep(200); return { vaults: clone(db.vaults), items: clone(db.items), trash: clone(db.trash) }; },
    'vault/saveItem': async function (m) {
      needUnlocked();
      var it = m.item || {};
      if (it.passkeys) throw AkErr('INVALID', 'popup must not send passkeys');
      await sleep(250);
      var t = Date.now();
      var cur = it.id && db.items.find(function (x) { return x.id === it.id; });
      if (it.id && !cur) throw AkErr('NOT_FOUND');
      if (cur) {
        var prevPw = cur.password;
        var keep = {
          passkeys: cur.passkeys, createdAt: cur.createdAt, lastUsedAt: cur.lastUsedAt,
          passwordHistory: cur.passwordHistory, pendingPassword: cur.pendingPassword,
        };
        Object.assign(cur, it, keep, { updatedAt: t });
        if ('password' in it && it.password !== prevPw) { cur.password = prevPw; setPassword(cur, it.password, t); }
        return { item: clone(cur) };
      }
      if (it.type && TYPE_IDS.indexOf(it.type) < 0) throw AkErr('INVALID', 'unknown type');
      var login = !it.type || it.type === 'login';
      var base = login
        ? { type: 'login', url: '', username: '', password: '', totp: null }
        : it.type === 'note' ? {} : { fields: {} };
      var created = Object.assign(base, { vault: 'personal', title: '', note: '', fav: false, extra: [], hue: Math.floor(Math.random() * 360) },
        it, { id: 'new-' + t.toString(36), createdAt: t, updatedAt: t, lastUsedAt: null },
        login ? { passkeys: [], passwordUpdatedAt: it.password ? t : null } : {});
      db.items.push(created);
      return { item: clone(created) };
    },
    'vault/pendingPassword': async function (m) {
      needUnlocked(); await sleep(200);
      var cur = db.items.find(function (x) { return x.id === m.id; });
      if (!cur) throw AkErr('NOT_FOUND');
      var t = Date.now();
      if (m.action === 'set') {
        if (!m.password || m.password === cur.password) throw AkErr('INVALID');
        cur.pendingPassword = { password: m.password, createdAt: t };
      } else if (m.action === 'confirm') {
        if (!cur.pendingPassword) throw AkErr('NOT_FOUND');
        setPassword(cur, cur.pendingPassword.password, t);
      } else if (m.action === 'discard') {
        delete cur.pendingPassword;
      } else {
        throw AkErr('INVALID');
      }
      cur.updatedAt = t;
      return { item: clone(cur) };
    },
    'vault/deleteItem': async function (m) {
      needUnlocked(); await sleep(200);
      if (!toTrash([m.id]).length) throw AkErr('NOT_FOUND');
      return { ids: [m.id], trash: clone(db.trash) };
    },
    'vault/deleteItems': async function (m) {
      needUnlocked(); await sleep(300);
      if (!Array.isArray(m.ids) || !m.ids.length) throw AkErr('INVALID');
      var ids = toTrash(m.ids);
      if (!ids.length) throw AkErr('NOT_FOUND');
      return { deleted: ids.length, ids: ids, trash: clone(db.trash) };
    },
    'vault/restoreItems': async function (m) {
      needUnlocked(); await sleep(200);
      var want = {};
      (m.ids || []).forEach(function (id) { want[id] = true; });
      var back = [];
      db.trash = db.trash.filter(function (x) {
        if (!want[x.id]) return true;
        var it = Object.assign({}, x);
        delete it.deletedAt;
        if (!db.vaults.some(function (v) { return v.id === it.vault; })) it.vault = db.vaults[0].id;
        back.push(it);
        return false;
      });
      if (!back.length) throw AkErr('NOT_FOUND');
      db.items = back.concat(db.items);
      return { items: clone(back), trash: clone(db.trash) };
    },
    'vault/purgeItems': async function (m) {
      needUnlocked(); await sleep(200);
      var n = db.trash.length;
      if (m.all === true) db.trash = [];
      else {
        var gone = {};
        (m.ids || []).forEach(function (id) { gone[id] = true; });
        db.trash = db.trash.filter(function (x) { return !gone[x.id]; });
      }
      if (db.trash.length === n) throw AkErr('NOT_FOUND');
      return { purged: n - db.trash.length, trash: clone(db.trash) };
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
    'backup/status': async function () { needUnlocked(); return backupStatus(); },
    'backup/record': async function () { needUnlocked(); resetBackupClock(); return backupStatus(); },
    'backup/snooze': async function () {
      needUnlocked();
      db.backup.snoozedUntil = Date.now() + 7 * DAY;
      db.backup.snoozes++;
      return backupStatus();
    },
    'vault/export': async function () {
      needUnlocked(); await sleep(150);
      return { json: JSON.stringify({ format: 'akari-backup', version: 1, exportedAt: Date.now(), vault: { version: 1, kdf: { name: 'PBKDF2' }, wrappedKey: {}, data: {} } }) };
    },
    'vault/import': async function (m) {
      needUnlocked(); await sleep(800);
      if (m.masterPassword === 'wrong') throw AkErr('BAD_PASSWORD');
      var t = Date.now();
      db.items.push(L('imp1-' + t, 'personal', 'booking.com', 'haruka.sato@example.com', 'Tabi!Kyoto#2026', 200, { createdAt: t, updatedAt: t }));
      db.items.push(L('imp2-' + t, 'work', 'linear.app', 'haruka@studio-mori.jp', 'L1near-Issue-Board', 260, { createdAt: t, updatedAt: t }));
      return { count: 2 };
    },
    'vault/importItems': async function (m) {
      needUnlocked(); await sleep(700);
      if (!Array.isArray(m.items) || !db.vaults.some(function (v) { return v.id === m.vault; })) throw AkErr('INVALID');
      var t = Date.now();
      var out = { added: 0, duplicates: 0, invalid: 0, passkeys: 0 };
      m.items.forEach(function (it, i) {
        if (!it || TYPE_IDS.indexOf(it.type || 'login') < 0 || !it.title) { out.invalid++; return; }
        var dup = db.items.some(function (x) {
          if (x.type !== (it.type || 'login')) return false;
          if (it.type === 'note') return x.title === it.title && x.note === it.note;
          if (it.type && it.type !== 'login') return x.title === it.title && JSON.stringify(x.fields || {}) === JSON.stringify(it.fields || {});
          return hostOf(x.url) === hostOf(it.url) && x.username === it.username && x.password === it.password;
        });
        if (dup) { out.duplicates++; return; }
        var pks = (it.passkeys || []).map(function (p) { return Object.assign({}, p, { privateKey: undefined, publicKey: 'pk', alg: -7, signCount: 0, lastUsedAt: null }); });
        out.passkeys += pks.length;
        var defaults = !it.type || it.type === 'login' ? { url: '', username: '', password: '', totp: null } : {};
        db.items.push(Object.assign(defaults, { note: '', fav: false, extra: [] }, it, {
          id: 'imp-' + t.toString(36) + '-' + i, vault: m.vault, hue: Math.floor(Math.random() * 360), passkeys: pks,
          createdAt: it.createdAt || t, updatedAt: it.updatedAt || t, passwordUpdatedAt: it.password ? t : null, lastUsedAt: null,
        }));
        out.added++;
      });
      return out;
    },
    'vault/exportPlain': async function (m) {
      needUnlocked(); await sleep(500);
      if (!m.masterPassword || m.masterPassword === 'wrong') throw AkErr('BAD_PASSWORD');
      var d = new Date(); var p = function (n) { return String(n).padStart(2, '0'); };
      var stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
      var q = function (v) { var s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      if (m.format === 'csv') {
        var rows = [['name', 'url', 'username', 'password', 'note', 'totp', 'vault', 'favorite']].concat(db.items.map(function (x) {
          return [x.title, x.url, x.username, x.password, x.note, x.totp ? 'otpauth://totp/?secret=' + x.totp.secret : '', x.vault, x.fav ? '1' : ''];
        }));
        return { text: rows.map(function (r) { return r.map(q).join(','); }).join('\r\n') + '\r\n', filename: 'akari-export-' + stamp + '.csv', count: db.items.length };
      }
      if (m.format === 'bitwarden') {
        return { text: JSON.stringify({ encrypted: false, folders: db.vaults.map(function (v) { return { id: v.id, name: v.name }; }), items: db.items.map(function (x) { return { name: x.title, login: { username: x.username, password: x.password } }; }) }, null, 2), filename: 'akari-export-' + stamp + '.json', count: db.items.length };
      }
      throw AkErr('INVALID');
    },
    'vault/createVault': async function (m) {
      needUnlocked(); await sleep(200);
      var name = vaultName(m.name, null);
      if (db.vaults.length >= 20) throw AkErr('INVALID', 'Too many vaults');
      if (!Number.isInteger(m.hue) || m.hue < 0 || m.hue > 359) throw AkErr('INVALID', 'Invalid hue');
      var v = { id: 'v-' + Math.random().toString(36).slice(2, 10), name: name, hue: m.hue };
      db.vaults.push(v);
      return { vault: clone(v), vaults: clone(db.vaults) };
    },
    'vault/updateVault': async function (m) {
      needUnlocked(); await sleep(200);
      var v = db.vaults.find(function (x) { return x.id === m.id; });
      if (!v) throw AkErr('NOT_FOUND');
      if (m.name !== undefined) v.name = vaultName(m.name, v.id);
      if (m.hue !== undefined) v.hue = m.hue;
      return { vault: clone(v), vaults: clone(db.vaults) };
    },
    'vault/deleteVault': async function (m) {
      needUnlocked(); await sleep(250);
      var i = db.vaults.findIndex(function (x) { return x.id === m.id; });
      if (i < 0) throw AkErr('NOT_FOUND');
      if (db.vaults.length <= 1) throw AkErr('INVALID', 'The last vault cannot be deleted');
      var to = m.moveTo == null ? null : m.moveTo;
      if (to !== null && (to === m.id || !db.vaults.some(function (x) { return x.id === to; }))) throw AkErr('INVALID');
      if (to === null && m.deleteItems !== true && db.items.some(function (x) { return x.vault === m.id; })) throw AkErr('NOT_EMPTY', 'Vault is not empty');
      var moved = 0; var deleted = 0;
      if (to !== null) db.items.forEach(function (x) { if (x.vault === m.id) { x.vault = to; x.updatedAt = Date.now(); moved++; } });
      else deleted = toTrash(db.items.filter(function (x) { return x.vault === m.id; }).map(function (x) { return x.id; })).length;
      db.vaults.splice(i, 1);
      return { moved: moved, deleted: deleted, vaults: clone(db.vaults), trash: clone(db.trash) };
    },
    'settings/get': function () { return clone(db.settings); },
    'settings/set': async function (m) {
      var patch = m.patch || {};
      if (patch.autoLockMinutes === -1 && db.settings.autoLockMinutes !== -1) {
        await sleep(400);
        if (!m.masterPassword || m.masterPassword === 'wrong') throw AkErr('BAD_PASSWORD', 'Wrong master password');
      }
      Object.assign(db.settings, patch);
      return clone(db.settings);
    },
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

  function setPassword(item, next, t) {
    var prev = item.password || '';
    if (item.pendingPassword && item.pendingPassword.password === next) delete item.pendingPassword;
    if (next === prev) return;
    var rest = (item.passwordHistory || []).filter(function (h) { return h.password !== prev && h.password !== next; });
    var hist = prev ? [{ password: prev, changedAt: t }].concat(rest) : rest;
    if (hist.length) item.passwordHistory = hist.slice(0, 10); else delete item.passwordHistory;
    item.password = next;
    item.passwordUpdatedAt = t;
  }

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
      getManifest: function () { return { name: 'Akari', version: '1.0.0', manifest_version: 3 }; },
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
    i18n: { getUILanguage: function () { return cfg.uiLang; } },
  };

  try {
    Object.defineProperty(window, 'chrome', { value: chromeMock, configurable: true, writable: true });
  } catch (e) {
    window.chrome = chromeMock;
  }
  window.close = function () { console.log('[mock] window.close()'); };
})();
