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
  let filling = false;
  let lastUsername = '';
  let offerCooldownUntil = 0;
  const MAX_SCOPE_ANCESTORS = 8;
  const MAX_INPUTS_IN_LOGIN_SCOPE = 24;
  const MAX_FIELDS_IN_LOGIN_SCOPE = 8;
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
  const USER_HINT = /user|login|log-?in|e-?mail|account|member|identifier|(^|[-_.\s])id($|[-_.\s])|ユーザー?|アカウント|ログイン|メール|会員/i;
  const USER_HINT_STRONG = /user|login|log-?in|identifier|account|ユーザー?|アカウント|ログイン/i;
  const NOT_USER = /search|検索|query|captcha|otp|totp|verif|coupon|zip|postal|address|city|first|last|family/i;

  const acTokens = (el) => (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean);
  const isPasswordish = (el) => el.tagName === 'INPUT' && (el.type === 'password' || knownPassword.has(el));
  const describe = (el) =>
    [el.name, el.id, el.placeholder, el.getAttribute('aria-label')].filter(Boolean).join(' ');

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

  function findUsername(scope, anchor, loose) {
    const cands = inputsIn(scope).filter((i) => TEXT_TYPES.has(i.type) && !isPasswordish(i) && usable(i));
    const before = anchor ? cands.filter((c) => c.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING) : cands;
    const last = (fn) => {
      for (let i = before.length - 1; i >= 0; i--) if (fn(before[i])) return before[i];
      return null;
    };
    return (
      last((c) => acTokens(c).some((t) => t === 'username' || t === 'email')) ||
      last((c) => (c.type === 'email' || USER_HINT.test(describe(c))) && !NOT_USER.test(describe(c))) ||
      (loose ? last((c) => !NOT_USER.test(describe(c))) : null)
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
  const { el, orb, themed, visibilityGuard } = ui;

  function makeHost() {
    const made = ui.makeHost();
    hosts.add(made.host);
    return made;
  }

  const quietUntil = new WeakMap();
  const field = { el: null, role: null, host: null, root: null, btn: null, menu: null, open: false, hi: -1, rows: [], state: null, token: 0, guard: null };

  function removeFieldUi() {
    field.token++;
    if (field.guard) field.guard.stop();
    if (field.host) {
      hosts.delete(field.host);
      field.host.remove();
    }
    Object.assign(field, { el: null, role: null, host: null, root: null, btn: null, menu: null, open: false, hi: -1, rows: [], state: null, guard: null });
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
      const tile = el('span', 'tile', (Array.from(it.title || '?')[0] || '?').toUpperCase());
      tile.style.setProperty('--h', String(Number(it.hue) || 0));
      const txt = el('span', 'txt');
      txt.appendChild(el('span', 't', it.title || ''));
      if (it.username) txt.appendChild(el('span', 'u', it.username));
      row.append(tile, txt);
      row.addEventListener('click', (e) => {
        if (field.guard && field.guard.ok(e)) chooseItem(it.id);
      });
      menu.appendChild(row);
      field.rows.push({ row, id: it.id });
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

  function openMenu() {
    const s = field.state;
    if (!s) return;
    if (s.locked) renderMenu([], lockedText());
    else renderMenu(s.items);
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
    if (!field.host) {
      const { host, root } = makeHost();
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
    place();
  }

  function considerFocus(target) {
    const role = target && fieldRole(target);
    if (role === 'username' || role === 'password') onFieldFocus(target, role);
    else if (field.el && !field.open) removeFieldUi();
  }

  const bar = { host: null, guard: null };

  function hideSaveBar() {
    if (bar.guard) bar.guard.stop();
    bar.guard = null;
    if (bar.host) {
      hosts.delete(bar.host);
      bar.host.remove();
    }
    bar.host = null;
  }

  function showSaveBar({ action, username, host: siteHost }) {
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
    const who = el('div', 'who', [siteHost, username].filter(Boolean).join(' · '));
    const msg = el('div', 'msg');
    msg.hidden = true;
    const btns = el('div', 'btns');
    const save = el('button', 'btn primary', action === 'update' ? t('更新') : t('保存'));
    const skip = el('button', 'btn ghost', t('今回はしない'));
    save.type = skip.type = 'button';
    btns.append(skip, save);
    const body = el('div', 'body');
    body.append(who, msg, btns);
    card.append(head, body);
    root.appendChild(card);
    const guard = visibilityGuard(card, () => host);
    bar.guard = guard;

    const note = (text) => {
      msg.textContent = text;
      msg.hidden = false;
    };
    save.addEventListener('click', async (e) => {
      if (!guard.ok(e)) return;
      save.disabled = skip.disabled = true;
      msg.hidden = true;
      const res = await send(M.CONFIRM_SAVE, { decision: 'save' });
      if (res.ok && res.data.saved !== false) {
        const done = el('div', 'done');
        done.append(el('span', 'ok', '[ ok ]'), el('span', '', t('保存しました')));
        card.replaceChildren(done);
        setTimeout(() => bar.host === host && hideSaveBar(), SAVED_BAR_LINGER_MS);
        return;
      }
      if (res.ok) return hideSaveBar();
      save.disabled = skip.disabled = false;
      note(res.code === 'LOCKED' ? lockedText() : t('保存できませんでした'));
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
    let pw = filled.find((p) => acTokens(p).includes('new-password'));
    if (!pw) {
      const n = filled.length;
      pw = n > 1 && filled[n - 1].value === filled[n - 2].value ? filled[n - 2] : filled[0];
    }
    const user = findUsername(scope, pw, true);
    return { username: (user && user.value.trim()) || lastUsername, password: pw.value };
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

  async function offerSave(creds) {
    if (!isTop || !creds || !creds.password || Date.now() < offerCooldownUntil) return;
    offerCooldownUntil = Date.now() + OFFER_COOLDOWN_MS;
    const res = await send(M.OFFER_SAVE, { username: creds.username, password: creds.password });
    if (res.ok && (res.data.action === 'new' || res.data.action === 'update')) {
      showSaveBar({ action: res.data.action, username: res.data.username, host: res.data.host });
    }
  }

  document.addEventListener('focusin', (e) => {
    if (filling) return;
    const target = e.composedPath()[0];
    if (!target || hosts.has(target)) return;
    considerFocus(target);
  }, LISTEN_PASSIVE);

  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (field.el && !field.open && deepActive() !== field.el) removeFieldUi();
    }, FOCUSOUT_SETTLE_MS);
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
        chooseItem(field.rows[field.hi].id);
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
    const btn = e.composedPath().find((n) => isSubmitLike(n));
    if (!btn) return;
    const creds = credentialsFromButton(btn);
    if (creds) offerSave(creds);
    else noteUsername(btn.form || btn.closest('form') || btn.parentElement);
  }, LISTEN_PASSIVE);

  document.addEventListener('change', (e) => {
    const input = e.composedPath()[0];
    if (input && input.tagName === 'INPUT' && input.value && looksLikeUsername(input)) lastUsername = input.value.trim();
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
