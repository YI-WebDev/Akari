// Akari autofill content script (ISOLATED world, every http(s) frame).
// Classic script: no imports, message names mirror src/shared/messages.js.
//
// - never fills on its own: only on the popup / shortcut request (autofill/doFill) or a click
//   on a row of the inline menu
// - inline menu and save bar live in CLOSED shadow roots, built with textContent only
// - the page can never reach vault data: the service worker judges origins from sender.*

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

  // A content script left over from before an extension reload is dead: replace it.
  const previous = window.__akariAutofill;
  if (previous) {
    if (previous.alive()) return;
    try {
      previous.dispose();
    } catch {
      /* old context is gone */
    }
  }

  const M = {
    PAGE_MATCHES: 'autofill/pageMatches',
    REQUEST_FILL: 'autofill/requestFill',
    OFFER_SAVE: 'autofill/offerSave',
    CONFIRM_SAVE: 'autofill/confirmSave',
    DO_FILL: 'autofill/doFill',
  };
  const LOCKED_TEXT = 'Akari はロックされています — ツールバーのアイコンから解除してください';

  const isTop = window === window.top;
  const ac = new AbortController();
  const LISTEN = { capture: true, signal: ac.signal };
  const LISTEN_PASSIVE = { capture: true, passive: true, signal: ac.signal };
  const hosts = new Set(); // Akari's own shadow hosts: events from them are ignored
  const knownPassword = new WeakSet(); // inputs seen as type=password (they may turn into type=text via "show")
  let filling = false; // true while we move focus ourselves
  let lastUsername = ''; // for two-step logins where the password page has no username field
  let offerCooldownUntil = 0;

  // ---- messaging ---------------------------------------------------------------

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

  // ---- field detection ---------------------------------------------------------

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
      /* older engines: fall through to the size check */
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

  // Including open shadow roots (closed ones are invisible to us by design).
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

  /** The form, or (SPA without <form>) the nearest container that holds the field's counterpart. */
  function scopeOf(el) {
    if (el.form) return el.form;
    const wantPassword = !isPasswordish(el);
    let node = el.parentElement;
    for (let i = 0; node && node !== document.body && node !== document.documentElement && i < 8; i++) {
      const all = inputsIn(node);
      if (all.length > 24) break; // a big container is not a login form (and checking visibility is not free)
      const fields = all.filter(isFieldCandidate);
      if (fields.length > 8) break;
      if (wantPassword ? fields.some(isPasswordish) : fields.length > 1) return node;
      node = node.parentElement;
    }
    return el.parentElement || el.getRootNode();
  }

  /** Which password field of a scope is the *current* one (sign-up / change forms have new-password ones). */
  function currentPassword(pws) {
    const marked = pws.find((p) => acTokens(p).includes('current-password'));
    if (marked) return marked;
    const plain = pws.filter((p) => !acTokens(p).includes('new-password'));
    if (!plain.length) return null;
    if (pws.length === 2 && plain.length === 2) return null; // password + confirm: sign-up
    return plain[0];
  }

  /** Username field for a password field: autocomplete=username, then name hints, then the nearest one before it. */
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

  /** 'username' | 'password' (current) | 'new-password' | null */
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
    // First step of a two-step login: only trust an explicit hint.
    return acTokens(el).includes('username') ? 'username' : null;
  }

  // ---- filling -------------------------------------------------------------------

  const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

  // Native setter + bubbling input/change/blur, so React/Vue controlled inputs notice the value.
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
    let last = null;
    filling = true;
    try {
      if (target.username && username && fillField(target.username, username)) last = target.username;
      if (target.password && password && fillField(target.password, password)) last = target.password;
      if (last) last.focus({ preventScroll: true }); // leave the caret where Enter submits
    } catch {
      /* page removed the field meanwhile */
    } finally {
      filling = false;
    }
    removeFieldUi();
    return !!last;
  }

  /** Fill target for a popup / shortcut request: the focused form if any, else the first one. */
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
    if (pws.length) return null; // only sign-up / change-password forms: nothing to fill
    const user = deepInputs().find((i) => usable(i) && looksLikeUsername(i));
    return user ? { username: user, password: null } : null;
  }

  function onMessage(msg, sender, sendResponse) {
    if (!msg || msg.type !== M.DO_FILL || !isTop || sender.id !== chrome.runtime.id) return;
    // The service worker pinned the origin it verified; refuse if the tab moved on since.
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

  // ---- shadow UI plumbing ------------------------------------------------------

  // "Akari Terminal" look. System monospace fonts only: nothing is loaded into the page.
  const FONT = 'ui-monospace, "Cascadia Mono", Consolas, "BIZ UDGothic", monospace';
  const CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
* { font-family: ${FONT}; -webkit-font-smoothing: antialiased; }
.orb { position: fixed; display: block; margin: 0; padding: 0; border: 0; border-radius: 5px; cursor: pointer;
  background: #FF7A45; color: #14100D; font-weight: 700; text-align: center;
  box-shadow: 0 0 10px rgba(255, 122, 69, .5); transition: box-shadow .15s, transform .12s; }
.orb:hover { box-shadow: 0 0 16px rgba(255, 122, 69, .75); transform: scale(1.06); }
.menu { position: fixed; min-width: 260px; background: #1A1511; color: #F2E8DE; color-scheme: dark; border-radius: 8px; padding: 6px;
  border: 1px solid rgba(255, 214, 186, .14); box-shadow: 0 18px 40px rgba(0, 0, 0, .55); font-size: 12px; line-height: 1.45;
  animation: in .18s cubic-bezier(.2, .9, .2, 1) both; max-height: 60vh; overflow: auto;
  scrollbar-width: thin; scrollbar-color: rgba(255, 214, 186, .16) transparent; }
.row { position: relative; display: flex; align-items: center; gap: 10px; height: 42px; padding: 0 10px 0 16px;
  border-radius: 5px; cursor: pointer; transition: background .15s; }
.row::before { content: '›'; position: absolute; left: 5px; top: 13px; height: 16px; line-height: 16px; color: #FF7A45;
  font-size: 13px; font-weight: 700; opacity: 0; transform: translateX(-4px); transition: opacity .15s, transform .25s cubic-bezier(.3, 1.5, .5, 1); }
.row:hover { background: rgba(255, 200, 160, .05); }
.row.hi { background: rgba(255, 122, 69, .11); box-shadow: inset 0 0 0 1px rgba(255, 122, 69, .3); }
.row:hover::before, .row.hi::before { opacity: 1; transform: none; }
.tile { flex: none; width: 28px; height: 28px; border-radius: 6px; display: grid; place-items: center; font-weight: 700; font-size: 12px;
  background: oklch(0.72 0.12 var(--h, 55) / .13); border: 1px solid oklch(0.72 0.12 var(--h, 55) / .32); color: oklch(0.85 0.11 var(--h, 55)); }
.txt { min-width: 0; display: flex; flex-direction: column; }
.t { font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.u { color: #9C8D7F; font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.note { padding: 8px 10px; color: #B9AA9B; font-size: 11px; line-height: 1.55; }
.note::before { content: '! '; color: #FF7A45; font-weight: 700; }
.foot { display: flex; align-items: center; gap: 10px; margin-top: 4px; padding: 6px 4px 1px; border-top: 1px solid rgba(255, 214, 186, .08);
  color: #8A7B6D; font-size: 10px; line-height: 16px; white-space: nowrap; }
.mark { width: 14px; height: 14px; border-radius: 3px; background: #FF7A45; color: #14100D; font-size: 9px; font-weight: 700;
  line-height: 14px; text-align: center; }
.grow { flex: 1; }
.k { display: inline-block; margin-right: 4px; padding: 0 4px; border: 1px solid rgba(255, 214, 186, .14); border-radius: 3px; color: #B9AA9B;
  line-height: 14px; }
.bar { position: fixed; top: 16px; right: 16px; width: 340px; max-width: calc(100vw - 32px); background: #14100D; color: #F2E8DE;
  color-scheme: dark; border: 1px solid rgba(255, 214, 186, .14); border-radius: 8px; overflow: hidden; font-size: 12px; line-height: 1.45;
  box-shadow: 0 18px 40px rgba(0, 0, 0, .55); animation: in .22s cubic-bezier(.2, .9, .2, 1) both; }
.head { height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 12px; background: #1A1511;
  border-bottom: 1px solid rgba(255, 214, 186, .09); }
.head .orb { position: static; flex: none; cursor: default; box-shadow: 0 0 14px rgba(255, 122, 69, .5); }
.head .orb:hover { transform: none; }
.ttl { min-width: 0; font-size: 12.5px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tag { flex: none; margin-left: auto; padding: 0 6px; border: 1px solid rgba(255, 122, 69, .45); border-radius: 4px;
  background: rgba(255, 122, 69, .08); color: #FF9A6E; font-size: 10px; line-height: 18px; }
.body { padding: 12px; }
.who { color: #D7CABD; font-size: 11.5px; line-height: 16px; overflow-wrap: anywhere; }
.who::before { content: '> '; color: #FF7A45; font-weight: 700; }
.msg { margin-top: 6px; color: #FF6B5B; font-size: 11px; line-height: 16px; overflow-wrap: anywhere; }
.btns { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.btn { height: 32px; padding: 0 14px; border: 1px solid transparent; border-radius: 5px; font-size: 12px; cursor: pointer; white-space: nowrap;
  transition: border-color .15s, background .15s, box-shadow .2s, color .15s; }
.btn:disabled { opacity: .5; cursor: default; }
.btn:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(255, 122, 69, .35); }
.primary { min-width: 76px; background: #FF7A45; color: #14100D; font-weight: 700; }
.primary:hover:not(:disabled) { box-shadow: 0 0 18px rgba(255, 122, 69, .55); }
.ghost { background: transparent; color: #B9AA9B; border-color: rgba(255, 214, 186, .16); }
.ghost:hover:not(:disabled) { border-color: rgba(255, 122, 69, .55); background: rgba(255, 122, 69, .06); color: #F2E8DE; }
.done { display: flex; align-items: center; gap: 8px; padding: 12px; font-size: 12px; font-weight: 700; }
.ok { color: #9BD67E; font-weight: 400; }
@keyframes in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;
  let sheet = null;

  function makeHost() {
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
    }
    const host = document.createElement('div');
    // CSSOM (not a style attribute) so strict page CSP cannot block it.
    for (const [p, v] of [['all', 'initial'], ['position', 'fixed'], ['top', '0'], ['left', '0'], ['width', '0'],
      ['height', '0'], ['z-index', '2147483647'], ['display', 'block']]) {
      host.style.setProperty(p, v, 'important');
    }
    const root = host.attachShadow({ mode: 'closed' });
    root.adoptedStyleSheets = [sheet];
    hosts.add(host);
    document.documentElement.appendChild(host);
    return { host, root };
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function orb(size) {
    const b = el('button', 'orb', '灯');
    b.type = 'button';
    b.tabIndex = -1;
    b.setAttribute('aria-label', 'Akari');
    b.style.width = b.style.height = b.style.lineHeight = size + 'px';
    b.style.fontSize = Math.round(size * 0.58) + 'px';
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the page field
    return b;
  }

  // ---- clickjacking guard ---------------------------------------------------------
  //
  // A page we cannot trust (same-site XSS, user-content subdomain) can focus a field, then hide or cover our UI
  // (opacity on <html>, a pointer-events:none decoy on top) and lure the user into clicking or pressing Enter.
  // So a click/Enter on the menu or the save button only counts after IntersectionObserver v2 has reported the
  // element truly visible (not occluded, no opacity/filter/transform tricks) for VISIBLE_MS without a move,
  // the tab is visible, nothing in the ancestor chain is translucent and, for mouse clicks, our own host is
  // what is really under the pointer.

  const VISIBLE_MS = 500;

  function visibilityGuard(target, getHost) {
    let since = 0; // performance.now() since which the target has been continuously visible, 0 = not visible
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1];
        since = e.isIntersecting && e.isVisible && e.intersectionRatio >= 0.5 ? since || performance.now() : 0;
      },
      { threshold: [0, 0.5, 1], trackVisibility: true, delay: 100 },
    );
    io.observe(target);
    const opaque = (n) => parseFloat(getComputedStyle(n).opacity) >= 1;
    return {
      /** The target moved: it has to stay put for VISIBLE_MS again. */
      reset() {
        if (since) since = performance.now();
      },
      /** May this trusted click / keydown act on the target? */
      ok(e) {
        if (!e.isTrusted || document.visibilityState !== 'visible') return false;
        if (!since || performance.now() - since < VISIBLE_MS) return false;
        const host = getHost();
        if (!host || !host.isConnected) return false;
        for (let n = host; n; n = n.parentElement) if (!opaque(n)) return false;
        if (document.body && !opaque(document.body)) return false;
        // detail 0 = keyboard-activated click (focus is inside our shadow root, the page cannot put it there)
        if (e.type === 'click' && e.detail !== 0 && document.elementFromPoint(e.clientX, e.clientY) !== host) return false;
        return true;
      },
      stop() {
        io.disconnect();
        since = 0;
      },
    };
  }

  // ---- inline menu --------------------------------------------------------------

  const quietUntil = new WeakMap(); // input -> timestamp until which the DOM observer won't re-query for it
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
    field.btn.style.fontSize = Math.round(size * 0.58) + 'px';
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
    const menu = el('div', 'menu');
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
    // Key hints below the rows (the first row stays right under the field).
    const foot = el('div', 'foot');
    foot.append(el('span', 'mark', '灯'), el('span', 'grow'));
    const keys = field.rows.length ? [['↑↓', '選択'], ['⏎', '入力'], ['esc', '閉じる']] : [['esc', '閉じる']];
    for (const [key, label] of keys) {
      const hint = el('span');
      hint.append(el('span', 'k', key), label);
      foot.appendChild(hint);
    }
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
    if (s.locked) renderMenu([], LOCKED_TEXT);
    else renderMenu(s.items);
  }

  async function chooseItem(itemId) {
    const target = targetForField(field.el);
    closeMenu();
    const res = await send(M.REQUEST_FILL, { itemId });
    if (!res.ok) {
      if (field.root) renderMenu([], res.code === 'LOCKED' ? LOCKED_TEXT : 'このサイトでは使えません');
      return;
    }
    // Credentials live only in this stack frame; the page sees them once they are in the inputs.
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
      // Nothing useful to offer; don't re-ask on every DOM mutation while this field stays focused.
      quietUntil.set(input, Date.now() + 10000);
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

  // ---- save / update bar -------------------------------------------------------

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
    const card = el('div', 'bar');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Akari');
    const head = el('div', 'head');
    const logo = orb(20);
    logo.tabIndex = -1;
    head.append(
      logo,
      el('div', 'ttl', action === 'update' ? 'パスワードを更新しますか？' : 'Akari に保存しますか？'),
      el('span', 'tag', action === 'update' ? '更新' : '新規'),
    );
    const who = el('div', 'who', [siteHost, username].filter(Boolean).join(' · '));
    const msg = el('div', 'msg');
    msg.hidden = true;
    const btns = el('div', 'btns');
    const save = el('button', 'btn primary', '保存');
    const skip = el('button', 'btn ghost', '今回はしない');
    save.type = skip.type = 'button';
    btns.append(skip, save);
    const body = el('div', 'body');
    body.append(who, msg, btns);
    card.append(head, body);
    root.appendChild(card);
    // Saving/updating a password is as sensitive as filling one: same visibility rules as the menu.
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
        done.append(el('span', 'ok', '[ ok ]'), el('span', '', '保存しました'));
        card.replaceChildren(done);
        setTimeout(() => bar.host === host && hideSaveBar(), 1500);
        return;
      }
      if (res.ok) return hideSaveBar(); // candidate expired meanwhile
      save.disabled = skip.disabled = false;
      note(res.code === 'LOCKED' ? LOCKED_TEXT : '保存できませんでした');
    });
    const dismiss = () => {
      send(M.CONFIRM_SAVE, { decision: 'dismiss' });
      hideSaveBar();
    };
    skip.addEventListener('click', (e) => e.isTrusted && dismiss());
    card.addEventListener('keydown', (e) => e.isTrusted && e.key === 'Escape' && dismiss());
  }

  // ---- save prompt triggers -------------------------------------------------------

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
    for (let i = 0; node && node !== document.body && node !== document.documentElement && i < 8; i++) {
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

  async function offerSave(creds) {
    if (!isTop || !creds || !creds.password || Date.now() < offerCooldownUntil) return;
    offerCooldownUntil = Date.now() + 1500; // click + submit + Enter all fire for one login
    const res = await send(M.OFFER_SAVE, { username: creds.username, password: creds.password });
    if (res.ok && (res.data.action === 'new' || res.data.action === 'update')) {
      showSaveBar({ action: res.data.action, username: res.data.username, host: res.data.host });
    }
  }

  // ---- wiring ----------------------------------------------------------------------

  document.addEventListener('focusin', (e) => {
    if (filling) return;
    const target = e.composedPath()[0];
    if (!target || hosts.has(target)) return;
    considerFocus(target);
  }, LISTEN_PASSIVE);

  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (field.el && !field.open && deepActive() !== field.el) removeFieldUi();
    }, 200);
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
      const t = e.composedPath()[0];
      if (t && t.tagName === 'INPUT' && isPasswordish(t)) offerSave(credentialsFrom(scopeOf(t)));
    }
  }, LISTEN);

  document.addEventListener('submit', (e) => {
    if (e.isTrusted && e.target && e.target.tagName === 'FORM') offerSave(credentialsFrom(e.target));
  }, LISTEN_PASSIVE);

  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const btn = e.composedPath().find((n) => isSubmitLike(n));
    if (btn) offerSave(credentialsFromButton(btn));
  }, LISTEN_PASSIVE);

  document.addEventListener('change', (e) => {
    const t = e.composedPath()[0];
    if (t && t.tagName === 'INPUT' && t.value && looksLikeUsername(t)) lastUsername = t.value.trim();
  }, LISTEN_PASSIVE);

  window.addEventListener('scroll', schedulePlace, LISTEN_PASSIVE);
  window.addEventListener('resize', schedulePlace, LISTEN_PASSIVE);

  // Forms rendered later (SPA): remember password inputs, drop UI of vanished fields, pick up an autofocused field.
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
    }, 300);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  function dispose() {
    ac.abort();
    observer.disconnect();
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      /* context already invalidated */
    }
    for (const h of hosts) h.remove();
    hosts.clear();
  }
  window.__akariAutofill = { alive, dispose };

  // ---- init --------------------------------------------------------------------------

  for (const p of document.querySelectorAll('input[type="password"]')) knownPassword.add(p);
  considerFocus(deepActive());
  if (isTop) {
    // A save prompt carried over from the previous page of this tab (login -> redirect).
    send(M.PAGE_MATCHES).then((res) => {
      if (res.ok && res.data.pendingSave && !bar.host) showSaveBar(res.data.pendingSave);
    });
  }
})();
