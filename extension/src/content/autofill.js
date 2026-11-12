(() => {
  'use strict';

  if (!/^https?:$/.test(location.protocol) || !/html/.test(document.contentType || '')) return;

  const alive = () => {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  };

  const previous = window.__akariAutofill;
  if (previous) {
    if (previous.alive()) return;
    try {
      previous.dispose();
    } catch {
    }
  }

  const M = {
    PAGE_MATCHES: 'autofill/pageMatches',
    REQUEST_FILL: 'autofill/requestFill',
    OFFER_SAVE: 'autofill/offerSave',
    CONFIRM_SAVE: 'autofill/confirmSave',
    NOTE_USERNAME: 'autofill/noteUsername',
    SUGGEST_PASSWORD: 'autofill/suggestPassword',
    IDENTITIES: 'autofill/identities',
    REQUEST_IDENTITY: 'autofill/requestIdentity',
    PAGE_TOTP: 'autofill/pageTotp',
    REQUEST_TOTP: 'autofill/requestTotp',
    DO_FILL: 'autofill/doFill',
  };
  const t = (text) => (globalThis.__akariI18n ? globalThis.__akariI18n.t(text) : text);
  const lockedText = () => t('Akari はロックされています — ツールバーのアイコンから解除してください');

  const isTop = window === window.top;
  const ac = new AbortController();
  const LISTEN = { capture: true, signal: ac.signal };
  const LISTEN_PASSIVE = { capture: true, passive: true, signal: ac.signal };
  const hosts = new Set();
  const knownPassword = new WeakSet();
  const suggested = new WeakMap();
  let filling = false;
  let lastUsername = '';
  let offerCooldownUntil = 0;
  const MAX_SCOPE_ANCESTORS = 8;
  const MAX_INPUTS_IN_LOGIN_SCOPE = 24;
  const MAX_FIELDS_IN_LOGIN_SCOPE = 8;
  const MAX_NEW_PASSWORD_FIELDS = 2;
  const MAX_IDENTITY_SCAN = 80;
  const MIN_IDENTITY_FIELDS_IN_SCOPE = 3;
  const POSTAL_DIGITS = 7;
  const CODE_BOX_ANCESTORS = 4;
  const MAX_HINT_TEXT = 200;
  const MIN_READABLE_FONT_PX = 6;
  const MIN_READABLE_ALPHA = 0.5;
  const QUIET_AFTER_NO_MATCH_MS = 10000;
  const OFFER_COOLDOWN_MS = 1500;
  const SAVED_BAR_LINGER_MS = 1500;
  const FOCUSOUT_SETTLE_MS = 200;
  const DOM_CHANGE_DEBOUNCE_MS = 300;

  async function send(type, payload) {
    const fail = (code) => ({ ok: false, code });
    if (!alive()) return fail('INTERNAL');
    try {
      const res = await chrome.runtime.sendMessage({ ...payload, type });
      if (res && res.ok) return { ok: true, data: res.data };
      return fail((res && res.error && res.error.code) || 'INTERNAL');
    } catch {
      return fail('INTERNAL');
    }
  }

  const TEXT_TYPES = new Set(['text', 'email', 'tel']);
  const USER_HINT = /user|login|log-?in|mail|account|member|identifier|(^|[-_.\s])id($|[-_.\s])|ユーザー?|アカウント|ログイン|メール|会員/i;
  const USER_HINT_STRONG = /user|login|log-?in|identifier|account|ユーザー?|アカウント|ログイン/i;
  const NOT_USER = /search|検索|query|captcha|otp|totp|verif|coupon|zip|postal|address|city|first|last|family/i;
  const MAIL_ADDRESS = /mail[-_.\s]?address/gi;

  const acTokens = (el) => (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean);
  const isPasswordish = (el) => el.tagName === 'INPUT' && (el.type === 'password' || knownPassword.has(el));
  const describe = (el) =>
    [el.name, el.id, el.placeholder, el.getAttribute('aria-label')].filter(Boolean).join(' ');
  const notUser = (el) => NOT_USER.test(describe(el).replace(MAIL_ADDRESS, 'mail'));

  function isVisible(el) {
    if (!el.isConnected) return false;
    try {
      if (
        el.checkVisibility &&
        !el.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
          opacityProperty: true,
          visibilityProperty: true,
        })
      ) {
        return false;
      }
    } catch {
    }
    const r = el.getBoundingClientRect();
    return r.width >= 8 && r.height >= 8 && r.right + scrollX > 0 && r.bottom + scrollY > 0;
  }

  const usable = (el) => !el.disabled && !el.readOnly && !hosts.has(el) && isVisible(el);
  const isFieldCandidate = (el) =>
    (el.type === 'password' || TEXT_TYPES.has(el.type) || knownPassword.has(el)) && usable(el);

  const inputsIn = (scope) =>
    scope.tagName === 'FORM'
      ? Array.from(scope.elements).filter((e) => e.tagName === 'INPUT')
      : Array.from(scope.querySelectorAll('input'));
  const passwordsIn = (scope) => inputsIn(scope).filter((i) => isPasswordish(i) && usable(i));

  function deepInputs(root = document, out = []) {
    out.push(...root.querySelectorAll('input'));
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.shadowRoot) deepInputs(n.shadowRoot, out);
    }
    return out;
  }

  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function scopeOf(el) {
    if (el.form) return el.form;
    const wantPassword = !isPasswordish(el);
    let node = el.parentElement;
    for (let i = 0; node && node !== document.body && node !== document.documentElement && i < MAX_SCOPE_ANCESTORS; i++) {
      const all = inputsIn(node);
      if (all.length > MAX_INPUTS_IN_LOGIN_SCOPE) break;
      const fields = all.filter(isFieldCandidate);
      if (fields.length > MAX_FIELDS_IN_LOGIN_SCOPE) break;
      if (wantPassword ? fields.some(isPasswordish) : fields.length > 1) return node;
      node = node.parentElement;
    }
    return el.parentElement || el.getRootNode();
  }

  function currentPassword(pws) {
    const marked = pws.find((p) => acTokens(p).includes('current-password'));
    if (marked) return marked;
    const plain = pws.filter((p) => !acTokens(p).includes('new-password'));
    if (!plain.length) return null;
    const looksLikeSignUpWithConfirmation = pws.length === 2 && plain.length === 2;
    if (looksLikeSignUpWithConfirmation) return null;
    return plain[0];
  }

  const AUTOCOMPLETE_KIND = {
    'postal-code': 'postalCode', 'address-level1': 'state', 'address-level2': 'city',
    'address-line1': 'address1', 'street-address': 'address1', 'address-line2': 'address2',
    country: 'country', 'country-name': 'country',
  };
  const OTHER_AUTOCOMPLETE = /^(email|tel|url|sex|bday|organization|one-time-code|cc-|.*name$|.*password$)/;
  const KIND_HINTS = [
    ['postalCode', /zip|postal|post[-_ ]?code|郵便/i],
    ['state', /prefecture|(^|[-_.\s/[\]])(pref|state|province|region)($|[-_.\s/[\]\d])|都道府県/i],
    ['city', /(^|[-_.\s/[\]])(city|town|locality)|市区町村|市町村|市区郡/i],
    ['address2', /(address|addr|street)[-_.\s]*(line)?[-_.\s]*0?[23](?!\d)|line[-_.\s]?0?[23](?!\d)|(address|addr|street)\[[12]\]|(^|[-_.\s/[\]])(building|apartment|apt|suite)|住所\s*[2２]|建物|マンション|アパート|部屋|号室/i],
    ['address1', /address|addr|street|住所|番地|町名|丁目/i],
    ['country', /country|国名|国・地域/i],
  ];
  const NOT_ADDRESS_NAME = /(^|[^a-z])(e?-?mail(?!ing)|ip[-_ ]?addr|mac[-_ ]?addr|web[-_ ]?addr)|search|query|captcha|coupon|card|password|url|wallet|fax|kana(?!gawa|zawa)|furi|yomi|phonetic|ruby/i;
  const NOT_ADDRESS_LABEL = /e-?mail|メール|フリガナ|ふりがな|ひらがな|カタカナ|カナ(?!ダ)|かな|よみ|読み|カード|パスワード|IP\s?アドレス/i;
  const ADDRESS_KINDS = ['postalCode', 'state', 'city', 'address1', 'address2', 'country'];
  const SELECT_KINDS = ['state', 'country'];
  const JOINED_KINDS = ['state', 'city', 'address1', 'address2'];
  const WESTERN_ORDER = ['address1', 'address2', 'city', 'state'];
  const JOINS_INTO = {
    state: ['city', 'address1', 'address2'],
    city: ['address1', 'address2', 'state'],
    address1: ['city', 'address2', 'state'],
    address2: ['address1', 'city', 'state'],
  };
  const NON_ASCII = /[^\x00-\x7f]/;
  const CAMEL_EDGE = /([a-z\d])([A-Z])/g;

  const ownText = (label, el) => (label.contains(el)
    ? Array.from(label.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(' ')
    : label.textContent);
  const labelText = (el) => Array.from(el.labels || []).map((l) => ownText(l, el)).join(' ');

  function hintedKind(text, isName) {
    const hits = [];
    for (const [kind, re] of KIND_HINTS) {
      const m = re.exec(text);
      if (m) hits.push({ kind, at: m.index });
    }
    if (!hits.length) return null;
    const specific = isName ? hits.filter((h) => h.kind !== 'address1') : [];
    if (specific.length) return specific.reduce((a, b) => (b.at > a.at ? b : a)).kind;
    return hits.reduce((a, b) => (b.at < a.at ? b : a)).kind;
  }

  function identityKind(el) {
    if (!el || hosts.has(el)) return null;
    const select = el.tagName === 'SELECT';
    if (!select && (el.tagName !== 'INPUT' || !TEXT_TYPES.has(el.type) || el.type === 'email' || isPasswordish(el))) return null;
    const name = [el.name, el.id].filter(Boolean).join(' ').replace(CAMEL_EDGE, '$1_$2').slice(0, MAX_HINT_TEXT);
    const label = [el.getAttribute('aria-label'), labelText(el)].filter(Boolean).join(' ').slice(0, MAX_HINT_TEXT);
    if (NOT_ADDRESS_NAME.test(name) || NOT_ADDRESS_LABEL.test(label)) return null;
    const tokens = acTokens(el);
    const marked = tokens.map((token) => AUTOCOMPLETE_KIND[token]).find(Boolean);
    if (!marked && tokens.some((token) => OTHER_AUTOCOMPLETE.test(token))) return null;
    const fits = (kind) => !!kind && (select ? SELECT_KINDS.includes(kind) : el.type !== 'tel' || kind === 'postalCode');
    const placeholder = (el.placeholder || '').slice(0, MAX_HINT_TEXT);
    const byName = hintedKind(name, true);
    const byLabel = hintedKind(label, false);
    const named = byName === 'address1' && byLabel === 'address2' ? byLabel : byName;
    return [marked, named, byLabel, hintedKind(placeholder, false)].find(fits) || null;
  }

  function identityFieldsIn(scope) {
    const all = scope.tagName === 'FORM' ? Array.from(scope.elements) : Array.from(scope.querySelectorAll('input, select'));
    const out = [];
    for (const el of all.slice(0, MAX_IDENTITY_SCAN)) {
      const kind = identityKind(el);
      if (kind && usable(el)) out.push({ el, kind });
    }
    return out;
  }

  function identityScope(el) {
    if (el.form) return el.form;
    let node = el.parentElement;
    for (let i = 0; node && node !== document.body && node !== document.documentElement && i < MAX_SCOPE_ANCESTORS; i++) {
      if (identityFieldsIn(node).length >= MIN_IDENTITY_FIELDS_IN_SCOPE) return node;
      node = node.parentElement;
    }
    return el.parentElement || el.getRootNode();
  }

  const untouched = (el) => (el.tagName === 'SELECT' ? el.selectedIndex <= 0 || !el.value : !el.value);

  function alphaOf(color) {
    const m = /^rgba?\(([^)]*)\)$/.exec(color);
    const parts = m ? m[1].split(/[\s,/]+/).filter(Boolean) : [];
    return parts.length > 3 ? parseFloat(parts[3]) : 1;
  }

  function readable(el) {
    const style = getComputedStyle(el);
    if (parseFloat(style.fontSize) < MIN_READABLE_FONT_PX) return false;
    if (Math.min(alphaOf(style.color), alphaOf(style.webkitTextFillColor)) < MIN_READABLE_ALPHA) return false;
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.clipPath !== 'none' || s.maskImage !== 'none') return false;
    }
    return true;
  }

  function joinedInto(kind, fields, values) {
    const has = (k) => fields.some((f) => f.kind === k);
    const holds = (k) => fields.some((f) => f.kind === k && f.el.tagName === 'INPUT');
    const mine = JOINED_KINDS.filter((k) => values[k] && (k === kind || (!has(k) && JOINS_INTO[k].find(holds) === kind)));
    if (!mine.some((k) => NON_ASCII.test(values[k]))) return WESTERN_ORDER.filter((k) => mine.includes(k)).map((k) => values[k]).join(', ');
    return mine.map((k) => (k === 'address2' && mine.length > 1 ? ' ' : '') + values[k]).join('');
  }

  function identityValue(target, fields, values) {
    if (target.kind === 'country') return values.country || '';
    if (target.kind !== 'postalCode') return joinedInto(target.kind, fields, values);
    const value = values.postalCode || '';
    const digits = value.replace(/\D/g, '');
    const group = fields.filter((f) => f.kind === 'postalCode');
    const split = group.length === 2 && group[0].el.maxLength === 3 && group[1].el.maxLength === 4 && digits.length === POSTAL_DIGITS;
    if (split) return group[0] === target ? digits.slice(0, 3) : digits.slice(3);
    return target.el.maxLength > 0 && target.el.maxLength < value.length ? digits : value;
  }

  function fillSelect(el, value) {
    const want = value.trim().toLowerCase();
    const text = (o) => o.textContent.trim().toLowerCase();
    const options = Array.from(el.options).filter((o) => o.value && text(o).length > 1);
    const hit = options.find((o) => o.value.toLowerCase() === want || text(o) === want)
      || options.find((o) => text(o).startsWith(want) || want.startsWith(text(o)));
    if (!hit) return false;
    el.value = hit.value;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return true;
  }

  function newPasswordFields(scope) {
    const pws = passwordsIn(scope);
    const cur = currentPassword(pws);
    return pws.filter((p) => p !== cur);
  }

  const replaceable = (p, input) => p === input || !p.value || p.value === input.value || p.value === suggested.get(p);

  function findUsername(scope, anchor, loose, filledOnly = false) {
    const cands = inputsIn(scope)
      .filter((i) => TEXT_TYPES.has(i.type) && !isPasswordish(i) && usable(i) && (!filledOnly || i.value.trim()));
    const before = anchor ? cands.filter((c) => c.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING) : cands;
    const last = (fn) => {
      for (let i = before.length - 1; i >= 0; i--) if (fn(before[i])) return before[i];
      return null;
    };
    return (
      last((c) => acTokens(c).some((t) => t === 'username' || t === 'email')) ||
      last((c) => (c.type === 'email' || USER_HINT.test(describe(c))) && !notUser(c)) ||
      (loose ? last((c) => !notUser(c)) : null)
    );
  }

  function looksLikeUsername(el) {
    if (!TEXT_TYPES.has(el.type)) return false;
    const ac = acTokens(el);
    return ac.includes('username') || ac.includes('email') || el.type === 'email' || USER_HINT_STRONG.test(describe(el));
  }

  function fieldRole(el) {
    if (!el || el.tagName !== 'INPUT' || el.disabled || el.readOnly || hosts.has(el)) return null;
    if (isPasswordish(el)) {
      if (el.type === 'password') knownPassword.add(el);
      return currentPassword(passwordsIn(scopeOf(el))) === el ? 'password' : 'new-password';
    }
    if (!TEXT_TYPES.has(el.type)) return null;
    const scope = scopeOf(el);
    const pws = passwordsIn(scope);
    if (pws.length) {
      const cur = currentPassword(pws);
      return cur && findUsername(scope, cur, true) === el ? 'username' : null;
    }
    return acTokens(el).includes('username') ? 'username' : null;
  }

  const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

  function fillField(el, value) {
    try {
      el.focus({ preventScroll: true });
      nativeValueSetter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      el.blur();
    } catch {
      return false;
    }
    return el.value === value;
  }

  function fillTarget(target, username, password) {
    let lastFilled = null;
    filling = true;
    try {
      if (target.username && username && fillField(target.username, username)) lastFilled = target.username;
      if (target.password && password && fillField(target.password, password)) lastFilled = target.password;
      if (lastFilled) lastFilled.focus({ preventScroll: true });
    } catch {
    } finally {
      filling = false;
    }
    removeFieldUi();
    return !!lastFilled;
  }

  function findFillTarget() {
    const pws = deepInputs().filter((i) => isPasswordish(i) && usable(i));
    const targets = [];
    const seen = new Set();
    for (const pw of pws) {
      const scope = scopeOf(pw);
      if (seen.has(scope)) continue;
      seen.add(scope);
      const cur = currentPassword(passwordsIn(scope));
      if (cur) targets.push({ scope, password: cur, username: findUsername(scope, cur, true) });
    }
    if (targets.length) {
      const active = deepActive();
      return (active && targets.find((t) => t.scope.contains(active))) || targets[0];
    }
    if (pws.length) return null;
    const user = deepInputs().find((i) => usable(i) && looksLikeUsername(i));
    return user ? { username: user, password: null } : null;
  }

  function onMessage(msg, sender, sendResponse) {
    if (!msg || msg.type !== M.DO_FILL || !isTop || sender.id !== chrome.runtime.id) return;
    if (typeof msg.origin === 'string' && msg.origin !== location.origin) {
      sendResponse({ filled: false });
      return;
    }
    const target = findFillTarget();
    sendResponse({
      filled: target ? fillTarget(target, String(msg.username || ''), String(msg.password || '')) : false,
    });
  }
  chrome.runtime.onMessage.addListener(onMessage);

  const ui = globalThis.__akariShadowUi;
  const { el, orb, themed, visibilityGuard, sightWatch } = ui;

  function makeHost() {
    const made = ui.makeHost();
    hosts.add(made.host);
    return made;
  }

  const quietUntil = new WeakMap();
  const field = { el: null, role: null, host: null, root: null, btn: null, menu: null, open: false, hi: -1, rows: [], state: null, token: 0, guard: null, sight: null };

  function removeFieldUi() {
    field.token++;
    if (field.guard) field.guard.stop();
    if (field.sight) field.sight.stop();
    if (field.host) {
      hosts.delete(field.host);
      field.host.remove();
    }
    Object.assign(field, { el: null, role: null, host: null, root: null, btn: null, menu: null, open: false, hi: -1, rows: [], state: null, guard: null, sight: null });
  }

  function closeMenu() {
    if (field.guard) field.guard.stop();
    field.guard = null;
    if (field.menu) field.menu.remove();
    field.menu = null;
    field.open = false;
    field.hi = -1;
    field.rows = [];
  }

  function placeMenu(r) {
    const menu = field.menu;
    const w = Math.min(Math.max(r.width, 260), 360, innerWidth - 16);
    menu.style.width = w + 'px';
    const h = menu.offsetHeight;
    const below = innerHeight - r.bottom;
    const next = {
      left: Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px',
      top: (below < h + 12 && r.top > below ? Math.max(8, r.top - h - 6) : r.bottom + 6) + 'px',
    };
    let moved = false;
    for (const k of ['left', 'top']) {
      if (menu.style[k] !== next[k]) {
        menu.style[k] = next[k];
        moved = true;
      }
    }
    if (moved && field.guard) field.guard.reset();
  }

  function place() {
    if (!field.el || !field.btn) return;
    if (!field.el.isConnected || !isVisible(field.el)) {
      removeFieldUi();
      return;
    }
    const r = field.el.getBoundingClientRect();
    const size = Math.max(16, Math.min(24, Math.round(r.height - 8)));
    const offscreen = r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth;
    field.btn.style.display = offscreen || r.width < size * 3 ? 'none' : 'block';
    field.btn.style.width = field.btn.style.height = field.btn.style.lineHeight = size + 'px';
    field.btn.style.fontSize = Math.max(11, Math.round(size * 0.58)) + 'px';
    field.btn.style.left = Math.round(r.right - size - 6) + 'px';
    field.btn.style.top = Math.round(r.top + (r.height - size) / 2) + 'px';
    if (field.menu) placeMenu(r);
  }

  let placeFrame = 0;
  function schedulePlace() {
    if (placeFrame) return;
    placeFrame = requestAnimationFrame(() => {
      placeFrame = 0;
      place();
    });
  }

  const loginRows = (items) => (items || []).map((it) => ({
    glyph: (Array.from(it.title || '?')[0] || '?').toUpperCase(),
    hue: it.hue,
    title: it.title || '',
    sub: it.username,
    choose: () => chooseItem(it.id),
  }));

  const identityRows = (items) => (items || []).map((it) => ({
    glyph: (Array.from(it.title || it.name || '?')[0] || '?').toUpperCase(),
    hue: it.hue,
    title: it.title || it.name || '',
    sub: it.title ? it.name : '',
    choose: () => chooseIdentity(it.id),
  }));

  const totpRows = (items) => (items || []).map((it) => ({
    glyph: (Array.from(it.title || '?')[0] || '?').toUpperCase(),
    hue: it.hue,
    title: it.title || '',
    sub: [t('認証コード'), it.username].filter(Boolean).join(' · '),
    choose: () => chooseTotp(it.id),
  }));

  const suggestionRow = (password) => ({
    glyph: '*', hue: 40, title: t('強いパスワードを使う'), sub: password, choose: chooseSuggestion,
  });

  function renderMenu(rowsData, noteText) {
    if (!field.root || !field.el) return;
    if (field.guard) field.guard.stop();
    if (field.menu) field.menu.remove();
    const menu = themed(el('div', 'menu'));
    menu.setAttribute('role', 'listbox');
    menu.addEventListener('mousedown', (e) => e.preventDefault());
    field.rows = [];
    field.hi = -1;
    if (noteText) menu.appendChild(el('div', 'note', noteText));
    for (const it of rowsData || []) {
      const row = el('div', 'row');
      row.setAttribute('role', 'option');
      const tile = el('span', 'tile', it.glyph);
      tile.style.setProperty('--h', String(Number(it.hue) || 0));
      const txt = el('span', 'txt');
      txt.appendChild(el('span', 't', it.title));
      if (it.sub) txt.appendChild(el('span', 'u', it.sub));
      row.append(tile, txt);
      row.addEventListener('click', (e) => {
        if (field.guard && field.guard.ok(e)) it.choose();
      });
      menu.appendChild(row);
      field.rows.push({ row, choose: it.choose });
    }
    const foot = el('div', 'foot');
    foot.append(el('span', 'mark', '灯'), el('span', 'grow'));
    const keys = field.rows.length ? [['↑↓', t('選択')], ['⏎', t('入力')]] : [];
    for (const [key, label] of keys) {
      const hint = el('span');
      hint.append(el('span', 'k', key), label);
      foot.appendChild(hint);
    }
    const close = el('button', 'x x-sm', '×');
    close.type = 'button';
    close.title = t('閉じる (esc)');
    close.setAttribute('aria-label', t('閉じる'));
    close.addEventListener('click', (e) => {
      if (e.isTrusted) closeMenu();
    });
    foot.appendChild(close);
    menu.appendChild(foot);
    field.root.appendChild(menu);
    field.menu = menu;
    field.open = true;
    place();
    if (field.menu === menu) field.guard = visibilityGuard(menu, () => field.host);
  }

  function openMenu(byItself = false) {
    const s = field.state;
    if (!s) return;
    const sight = field.sight;
    if (field.role === 'identity' && sight && !sight.ready()) {
      const token = field.token;
      sight.settled.then(() => {
        if (token === field.token && !field.open && (!byItself || opensByItself(field.el))) openMenu(byItself);
      });
      return;
    }
    if (s.locked) renderMenu([], lockedText());
    else if (field.role === 'new-password') renderMenu([suggestionRow(s.password)]);
    else if (field.role === 'identity') renderMenu(identityRows(s.items), s.items.length ? '' : t('アイデンティティの情報なし'));
    else if (field.role === 'otp') renderMenu(totpRows(s.items));
    else renderMenu(loginRows(s.items));
  }

  async function chooseIdentity(itemId) {
    const input = field.el;
    const sight = field.sight;
    closeMenu();
    const fields = input && input.isConnected ? identityFieldsIn(identityScope(input)) : [];
    if (!fields.some((f) => f.el === input)) return;
    const wasSeen = (el) => !!sight && sight.seen(el) && readable(el);
    const targets = fields.filter((f) => f.el === input || (untouched(f.el) && wasSeen(f.el)));
    const joins = targets.some((f) => JOINED_KINDS.includes(f.kind));
    const kinds = Array.from(new Set(targets.map((f) => f.kind).concat(joins ? JOINED_KINDS : [])));
    const res = await send(M.REQUEST_IDENTITY, { itemId, kinds });
    if (!res.ok) {
      if (field.root) renderMenu([], res.code === 'LOCKED' ? lockedText() : t('このサイトでは使えません'));
      return;
    }
    removeFieldUi();
    if (!input.isConnected) return;
    filling = true;
    try {
      for (const f of targets) {
        if (!f.el.isConnected) continue;
        const value = identityValue(f, fields, res.data.values);
        if (!value) continue;
        if (f.el.tagName === 'SELECT') fillSelect(f.el, value);
        else fillField(f.el, value);
      }
      input.focus({ preventScroll: true });
    } catch {
    } finally {
      filling = false;
    }
    considerFocus(deepActive());
  }

  async function chooseItem(itemId) {
    const target = targetForField(field.el);
    closeMenu();
    const res = await send(M.REQUEST_FILL, { itemId });
    if (!res.ok) {
      if (field.root) renderMenu([], res.code === 'LOCKED' ? lockedText() : t('このサイトでは使えません'));
      return;
    }
    fillTarget(target, res.data.username, res.data.password);
  }

  async function chooseSuggestion() {
    const input = field.el;
    const password = field.state && field.state.password;
    const scope = input && input.isConnected ? scopeOf(input) : null;
    const targets = scope ? newPasswordFields(scope) : [];
    closeMenu();
    if (!password || !targets.includes(input) || targets.length > MAX_NEW_PASSWORD_FIELDS) return removeFieldUi();
    const offered = await send(M.OFFER_SAVE, { username: usernameNear(scope, input), password, signUp: makesNewAccount(scope) });
    const withdraw = () => offered.ok && send(M.CONFIRM_SAVE, { decision: 'dismiss' });
    if (field.el !== input || !input.isConnected) return withdraw();
    if (!offered.ok) {
      if (field.root) renderMenu([], offered.code === 'LOCKED' ? lockedText() : t('保存できませんでした'));
      return;
    }
    removeFieldUi();
    let filled = 0;
    filling = true;
    try {
      for (const p of targets.filter((x) => x.isConnected && replaceable(x, input))) {
        if (!fillField(p, password)) continue;
        suggested.set(p, password);
        filled++;
      }
      input.focus({ preventScroll: true });
    } catch {
    } finally {
      filling = false;
    }
    if (!filled) withdraw();
    else if (offered.data.action === 'new' || offered.data.action === 'update') showSaveBar(offered.data, scope);
    considerFocus(deepActive());
  }

  function targetForField(el) {
    if (!el || !el.isConnected) return {};
    const scope = scopeOf(el);
    const cur = currentPassword(passwordsIn(scope));
    if (cur) return { password: cur, username: findUsername(scope, cur, true) };
    return field.role === 'username' ? { username: el } : { password: el };
  }

  function moveHighlight(delta) {
    if (!field.rows.length) return;
    field.hi = (field.hi + delta + field.rows.length) % field.rows.length;
    field.rows.forEach((r, i) => r.row.classList.toggle('hi', i === field.hi));
  }

  async function onFieldFocus(input, role) {
    closeMenu();
    if (field.el !== input) removeFieldUi();
    field.el = input;
    field.role = role;
    const token = ++field.token;
    const res = await send(M.PAGE_MATCHES);
    if (token !== field.token || field.el !== input) return;
    if (res.ok && res.data.pendingSave && isTop && !bar.host) showSaveBar(res.data.pendingSave);
    if (!res.ok || (!res.data.locked && !res.data.items.length)) {
      quietUntil.set(input, Date.now() + QUIET_AFTER_NO_MATCH_MS);
      return removeFieldUi();
    }
    field.state = res.data;
    showOrb();
    place();
  }

  function showOrb() {
    if (field.host) return;
    const { host, root } = makeHost();
    if (bar.host && bar.host.isConnected) bar.host.before(host);
    field.host = host;
    field.root = root;
    field.btn = orb(24);
    field.btn.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      e.stopPropagation();
      if (field.menu) closeMenu();
      else openMenu();
    });
    root.appendChild(field.btn);
  }

  const lengthLimits = (input) => ({
    minLength: input.minLength > 0 ? input.minLength : undefined,
    maxLength: input.maxLength > 0 ? input.maxLength : undefined,
  });

  const followsFocus = () => field.role === 'new-password' || field.role === 'identity' || field.role === 'otp';

  function opensByItself(input) {
    if (!field.state || field.state.locked || field.open || input.value) return false;
    if (field.role === 'identity' || field.role === 'otp') return true;
    return field.role === 'new-password' && newPasswordFields(scopeOf(input)).every((p) => replaceable(p, input));
  }

  async function onNewPasswordFocus(input) {
    removeFieldUi();
    const targets = newPasswordFields(scopeOf(input));
    if (!targets.includes(input) || targets.length > MAX_NEW_PASSWORD_FIELDS) return;
    field.el = input;
    field.role = 'new-password';
    const token = ++field.token;
    const res = await send(M.SUGGEST_PASSWORD, lengthLimits(input));
    if (token !== field.token || field.el !== input) return;
    if (!res.ok || (!res.data.locked && !res.data.password)) {
      quietUntil.set(input, Date.now() + QUIET_AFTER_NO_MATCH_MS);
      return removeFieldUi();
    }
    field.state = res.data;
    showOrb();
    place();
    if (opensByItself(input)) openMenu(true);
  }

  async function onIdentityFocus(input) {
    removeFieldUi();
    field.el = input;
    field.role = 'identity';
    const token = ++field.token;
    const sight = sightWatch(identityFieldsIn(identityScope(input)).map((f) => f.el));
    field.sight = sight;
    const res = await send(M.IDENTITIES);
    if (token !== field.token || field.el !== input) return;
    if (!res.ok) {
      quietUntil.set(input, Date.now() + QUIET_AFTER_NO_MATCH_MS);
      return removeFieldUi();
    }
    field.state = res.data;
    showOrb();
    place();
    if (opensByItself(input)) openMenu(true);
  }

  const OTP_TYPES = new Set(['text', 'tel', 'number', 'password']);
  const OTP_HINT = /(^|[^a-z])t?otp|2fa|(^|[^a-z])mfa|one[-_ ]?time|two[-_ ]?(factor|step)|verif[a-z]*[-_ ]?(code|token)|auth[a-z]*[-_ ]?(code|token|app)|passcode|認証コード|確認コード|認証アプリ|ワンタイム|[2二] ?段階/i;
  const NOT_OTP = /card|cvv|cvc|cvn|カード|coupon|クーポン|captcha|画像|promo|invit|招待|referral|zip|postal|郵便|sms|text message|ショートメッセージ|e-?mail|メール|phone[-_]|mobile[-_]|電話|backup|recovery|バックアップ|リカバリ/i;
  let askingCodeFor = null;

  const marksOneTimeCode = (el) => acTokens(el).includes('one-time-code');

  function isOtpField(el) {
    if (!el || el.tagName !== 'INPUT' || !OTP_TYPES.has(el.type) || !usable(el)) return false;
    const name = [el.name, el.id].filter(Boolean).join(' ').replace(CAMEL_EDGE, '$1_$2');
    const text = [name, el.getAttribute('aria-label'), labelText(el), el.placeholder].filter(Boolean).join(' ').slice(0, MAX_HINT_TEXT);
    if (NOT_OTP.test(text)) return false;
    return marksOneTimeCode(el) || (el.type !== 'password' && OTP_HINT.test(text));
  }

  function codeTargets(input, length) {
    if (input.maxLength !== 1) return [input];
    let node = input.parentElement;
    for (let i = 0; node && i < CODE_BOX_ANCESTORS; i++, node = node.parentElement) {
      const boxes = Array.from(node.querySelectorAll('input')).filter((b) => b.maxLength === 1 && usable(b));
      if (boxes.length === length) return boxes;
      if (boxes.length > length) break;
    }
    return [];
  }

  function fillCode(input, code, onlyIfEmpty = false) {
    const targets = input.isConnected ? codeTargets(input, code.length) : [];
    if (!targets.length || (onlyIfEmpty && targets.some((el) => el.value))) return false;
    filling = true;
    try {
      targets.forEach((el, i) => fillField(el, targets.length === 1 ? code : code[i]));
      targets[targets.length - 1].focus({ preventScroll: true });
    } catch {
    } finally {
      filling = false;
    }
    return true;
  }

  async function chooseTotp(itemId) {
    const input = field.el;
    closeMenu();
    const res = await send(M.REQUEST_TOTP, { itemId });
    if (field.el !== input) return;
    if (!res.ok) {
      if (field.root) renderMenu([], res.code === 'LOCKED' ? lockedText() : t('このサイトでは使えません'));
      return;
    }
    removeFieldUi();
    fillCode(input, res.data.code);
    considerFocus(deepActive());
  }

  async function onOtpFocus(input) {
    if (askingCodeFor === input) return;
    removeFieldUi();
    field.el = input;
    field.role = 'otp';
    const token = ++field.token;
    const fill = !input.value && document.visibilityState === 'visible' && document.hasFocus();
    askingCodeFor = input;
    const res = await send(M.PAGE_TOTP, { fill });
    askingCodeFor = null;
    if (token !== field.token || field.el !== input) return;
    if (!res.ok || (!res.data.locked && !res.data.items.length)) {
      quietUntil.set(input, Date.now() + QUIET_AFTER_NO_MATCH_MS);
      return removeFieldUi();
    }
    if (res.data.code && fillCode(input, res.data.code, true)) {
      removeFieldUi();
      return considerFocus(deepActive());
    }
    field.state = res.data;
    showOrb();
    place();
    if (opensByItself(input)) openMenu(true);
  }

  const isAddressField = (el) => el.tagName === 'INPUT' && usable(el) && ADDRESS_KINDS.includes(identityKind(el));

  const closesWhenFocusLeaves = () => !field.open || followsFocus();

  function considerFocus(target) {
    const role = target && fieldRole(target);
    const asksForCode = isTop && !!target && isOtpField(target) && (!role || marksOneTimeCode(target));
    if (asksForCode) onOtpFocus(target);
    else if (role === 'username' || role === 'password') onFieldFocus(target, role);
    else if (role === 'new-password' && isTop) onNewPasswordFocus(target);
    else if (!role && isTop && target && isAddressField(target)) onIdentityFocus(target);
    else if (field.el && closesWhenFocusLeaves()) removeFieldUi();
  }

  const bar = { host: null, guard: null, sync: null };
  const MASKED_PASSWORD = '•'.repeat(12);

  function hideSaveBar() {
    if (bar.guard) bar.guard.stop();
    bar.guard = null;
    bar.sync = null;
    if (bar.host) {
      hosts.delete(bar.host);
      bar.host.remove();
    }
    bar.host = null;
  }

  function showSaveBar({ action, username, host: siteHost }, scope) {
    if (!isTop) return;
    hideSaveBar();
    const { host, root } = makeHost();
    bar.host = host;
    const card = themed(el('div', 'bar'));
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Akari');
    const head = el('div', 'head');
    const logo = orb(20);
    logo.tabIndex = -1;
    head.append(
      logo,
      el('div', 'ttl', action === 'update' ? t('パスワードを更新しますか？') : t('Akari に保存しますか？')),
      el('span', 'tag', action === 'update' ? t('更新') : t('新規')),
    );
    const saved = el('dl', 'kv');
    const put = (label, value, cls) => {
      const dd = el('dd', cls, value);
      dd.title = value;
      saved.append(el('dt', '', label), dd);
    };
    put(t('サイト'), siteHost || '');
    put(t('ユーザー名'), username || t('（なし）'), username ? '' : 'none');
    put(t('パスワード'), MASKED_PASSWORD);
    const msg = el('div', 'msg');
    msg.hidden = true;
    const btns = el('div', 'btns');
    const save = el('button', 'btn primary', action === 'update' ? t('更新') : t('保存'));
    const skip = el('button', 'btn ghost', t('今回はしない'));
    save.type = skip.type = 'button';
    btns.append(skip, save);
    const body = el('div', 'body');
    body.append(saved, msg, btns);
    card.append(head, body);
    root.appendChild(card);
    const guard = visibilityGuard(card, () => host);
    bar.guard = guard;

    const note = (text) => {
      msg.textContent = text;
      msg.hidden = false;
    };
    const failed = (res) => {
      save.disabled = skip.disabled = false;
      note(res.code === 'LOCKED' ? lockedText() : t('保存できませんでした'));
    };
    const differs = (offered) => offered.action !== action || offered.username !== username;
    if (scope) {
      bar.sync = async (changed) => {
        if (save.disabled || !scope.isConnected || !scope.contains(changed)) return;
        const inForm = credentialsFrom(scope);
        if (!inForm) return;
        const again = await send(M.OFFER_SAVE, inForm);
        if (bar.host !== host || save.disabled || !again.ok) return;
        if (again.data.action === 'none') hideSaveBar();
        else if (differs(again.data)) showSaveBar(again.data, scope);
      };
    }
    save.addEventListener('click', async (e) => {
      if (!guard.ok(e)) return;
      save.disabled = skip.disabled = true;
      msg.hidden = true;
      const inForm = scope && scope.isConnected ? credentialsFrom(scope) : null;
      if (inForm) {
        const again = await send(M.OFFER_SAVE, inForm);
        if (!again.ok) return failed(again);
        if (again.data.action === 'none') return hideSaveBar();
        if (differs(again.data)) return showSaveBar(again.data, scope);
      }
      const res = await send(M.CONFIRM_SAVE, { decision: 'save' });
      if (res.ok && res.data.saved !== false) {
        const done = el('div', 'done');
        done.append(el('span', 'ok', '[ ok ]'), el('span', '', t('保存しました')));
        card.replaceChildren(done);
        setTimeout(() => bar.host === host && hideSaveBar(), SAVED_BAR_LINGER_MS);
        return;
      }
      if (res.ok) return hideSaveBar();
      failed(res);
    });
    const dismiss = () => {
      send(M.CONFIRM_SAVE, { decision: 'dismiss' });
      hideSaveBar();
    };
    skip.addEventListener('click', (e) => e.isTrusted && dismiss());
    card.addEventListener('keydown', (e) => e.isTrusted && e.key === 'Escape' && dismiss());
  }

  function credentialsFrom(scope) {
    const filled = passwordsIn(scope).filter((p) => p.value);
    if (!filled.length) return null;
    let pw = filled.find((p) => suggested.get(p) === p.value) || filled.find((p) => acTokens(p).includes('new-password'));
    if (!pw) {
      const n = filled.length;
      pw = n > 1 && filled[n - 1].value === filled[n - 2].value ? filled[n - 2] : filled[0];
    }
    return { username: usernameNear(scope, pw), password: pw.value, signUp: suggested.get(pw) === pw.value && makesNewAccount(scope) };
  }

  const makesNewAccount = (scope) => !currentPassword(passwordsIn(scope))
    && inputsIn(scope).some((i) => TEXT_TYPES.has(i.type) && !isPasswordish(i) && usable(i) && !notUser(i));

  function usernameNear(scope, pw) {
    const user = findUsername(scope, pw, false, true) || findUsername(scope, null, false, true) || findUsername(scope, pw, true, true);
    return (user && user.value.trim()) || lastUsername;
  }

  function credentialsFromButton(btn) {
    if (btn.form) return credentialsFrom(btn.form);
    let node = btn.parentElement;
    for (let i = 0; node && node !== document.body && node !== document.documentElement && i < MAX_SCOPE_ANCESTORS; i++) {
      const pw = passwordsIn(node).find((p) => p.value);
      if (pw) return credentialsFrom(scopeOf(pw));
      node = node.parentElement;
    }
    return null;
  }

  const SUBMIT_TEXT = /log\s?in|sign\s?in|sign\s?up|register|submit|continue|next|create|ログイン|サインイン|ログオン|送信|次へ|続ける|登録|新規|作成|変更|更新/i;
  const NOT_SUBMIT = /show|hide|reveal|toggle|forgot|reset|表示|非表示|隠す|忘れ/i;
  const labelOf = (n) => (n.getAttribute('aria-label') || n.value || n.textContent || '').trim().slice(0, 60);

  function isSubmitLike(n) {
    if (n.nodeType !== 1) return false;
    if (n.tagName !== 'BUTTON' && n.tagName !== 'INPUT' && n.getAttribute('role') !== 'button') return false;
    const label = labelOf(n);
    if (NOT_SUBMIT.test(label)) return false;
    if (n.tagName === 'INPUT') {
      return n.type === 'submit' || n.type === 'image' || (n.type === 'button' && SUBMIT_TEXT.test(label));
    }
    if (n.tagName === 'BUTTON') {
      const explicit = (n.getAttribute('type') || '').toLowerCase();
      return explicit === 'submit' || (!explicit && !!n.form) || SUBMIT_TEXT.test(label);
    }
    return n.getAttribute('role') === 'button' && SUBMIT_TEXT.test(label);
  }

  function noteUsername(scope) {
    if (!scope || passwordsIn(scope).some((p) => p.value)) return;
    const user = deepInputs(scope).find((el) => el.value && el.value.trim() && looksLikeUsername(el) && isVisible(el));
    if (user) send(M.NOTE_USERNAME, { username: user.value.trim() });
  }

  async function offer(creds, scope) {
    const res = await send(M.OFFER_SAVE, { username: creds.username, password: creds.password, signUp: creds.signUp });
    if (res.ok && (res.data.action === 'new' || res.data.action === 'update')) {
      showSaveBar({ action: res.data.action, username: res.data.username, host: res.data.host }, scope);
    }
  }

  async function offerSave(creds) {
    if (!isTop || !creds || !creds.password || Date.now() < offerCooldownUntil) return;
    offerCooldownUntil = Date.now() + OFFER_COOLDOWN_MS;
    await offer(creds);
  }

  document.addEventListener('focusin', (e) => {
    if (filling) return;
    const target = e.composedPath()[0];
    if (!target || hosts.has(target)) return;
    considerFocus(target);
  }, LISTEN_PASSIVE);

  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (field.el && closesWhenFocusLeaves() && deepActive() !== field.el) removeFieldUi();
    }, FOCUSOUT_SETTLE_MS);
  }, LISTEN_PASSIVE);

  document.addEventListener('input', (e) => {
    if (filling || !followsFocus() || e.composedPath()[0] !== field.el) return;
    if (field.el.value) closeMenu();
    else if (opensByItself(field.el)) openMenu(true);
  }, LISTEN_PASSIVE);

  document.addEventListener('pointerdown', (e) => {
    if (field.open && !e.composedPath().includes(field.host)) closeMenu();
  }, LISTEN_PASSIVE);

  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    if (field.open) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        moveHighlight(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Enter' && field.hi >= 0 && field.guard && field.guard.ok(e)) {
        e.preventDefault();
        e.stopPropagation();
        field.rows[field.hi].choose();
        return;
      }
    }
    if (e.key === 'Enter' && !e.isComposing) {
      const input = e.composedPath()[0];
      if (input && input.tagName === 'INPUT' && isPasswordish(input)) offerSave(credentialsFrom(scopeOf(input)));
      else if (input && input.tagName === 'INPUT' && looksLikeUsername(input)) noteUsername(scopeOf(input));
    }
  }, LISTEN);

  document.addEventListener('submit', (e) => {
    if (!e.isTrusted || !e.target || e.target.tagName !== 'FORM') return;
    const creds = credentialsFrom(e.target);
    if (creds) offerSave(creds);
    else noteUsername(e.target);
  }, LISTEN_PASSIVE);

  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const clicked = e.composedPath()[0];
    if (followsFocus() && clicked === field.el && opensByItself(clicked)) openMenu(true);
    const btn = e.composedPath().find((n) => isSubmitLike(n));
    if (!btn) return;
    const creds = credentialsFromButton(btn);
    if (creds) offerSave(creds);
    else noteUsername(btn.form || btn.closest('form') || btn.parentElement);
  }, LISTEN_PASSIVE);

  document.addEventListener('change', (e) => {
    const input = e.composedPath()[0];
    if (input && input.tagName === 'INPUT' && input.value && looksLikeUsername(input)) lastUsername = input.value.trim();
    if (input && bar.sync && !filling) bar.sync(input);
  }, LISTEN_PASSIVE);

  window.addEventListener('scroll', schedulePlace, LISTEN_PASSIVE);
  window.addEventListener('resize', schedulePlace, LISTEN_PASSIVE);

  let domTimer = 0;
  const observer = new MutationObserver(() => {
    if (domTimer) return;
    domTimer = setTimeout(() => {
      domTimer = 0;
      for (const p of document.querySelectorAll('input[type="password"]')) knownPassword.add(p);
      if (field.el) place();
      else {
        const active = deepActive();
        if (active && !(quietUntil.get(active) > Date.now())) considerFocus(active);
      }
    }, DOM_CHANGE_DEBOUNCE_MS);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  function dispose() {
    ac.abort();
    observer.disconnect();
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
    }
    for (const h of hosts) h.remove();
    hosts.clear();
  }
  window.__akariAutofill = { alive, dispose };

  for (const p of document.querySelectorAll('input[type="password"]')) knownPassword.add(p);
  considerFocus(deepActive());
  if (isTop) {
    send(M.PAGE_MATCHES).then((res) => {
      if (res.ok && res.data.pendingSave && !bar.host) showSaveBar(res.data.pendingSave);
    });
  }
})();
