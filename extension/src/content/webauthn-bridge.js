// Akari WebAuthn bridge (ISOLATED world, top frame). Classic script; uses the in-page UI kit
// (shadow-ui.js, loaded just before it). Relays requests from webauthn-page.js (MAIN world)
// to the service worker and the answers back. The service worker derives the origin from
// the sender, so nothing the page claims about its origin is trusted.
//
// Sign-in while Akari is unlocked happens on a card in the page: the service worker lists
// the site's passkeys, and a trusted click on one (once the card has been plainly visible
// for a moment) asks it to sign. Closing the card hands the request to whatever is next
// (another passkey manager, or the browser). The page only ever gets the credential.
(() => {
  'use strict';

  const TAG = 'webauthn';
  const TO_EXT = 'page→ext';
  const TO_PAGE = 'ext→page';
  const ORIGIN = location.origin;
  // Codes the page maps to DOMExceptions; anything else lets the browser handle the request.
  const PASS_THROUGH = new Set(['NOT_ALLOWED', 'FALLBACK', 'INVALID_STATE', 'SECURITY', 'NOT_SUPPORTED', 'INVALID']);
  const TYPES = { create: 'passkey/create', get: 'passkey/get' };
  const ASSERT = 'passkey/assert';
  const ui = globalThis.__akariShadowUi;

  if (ORIGIN === 'null' || window.top !== window || !ui) return;

  const reply = (id, body) => window.postMessage({ __akari: TAG, dir: TO_PAGE, id, ...body }, ORIGIN);

  async function send(message) {
    // Throws "Extension context invalidated" after the extension reloads.
    if (!chrome.runtime?.id) throw new Error('context invalidated');
    return chrome.runtime.sendMessage(message);
  }

  async function forward(d) {
    let res;
    try {
      res = await send({ type: TYPES[d.action], options: d.options, mediation: d.mediation, requestId: d.id });
    } catch {
      reply(d.id, { ok: false, code: 'FALLBACK' });
      return;
    }
    if (res && res.ok && res.data && res.data.credential) {
      reply(d.id, { ok: true, credential: res.data.credential });
      return;
    }
    if (d.action === 'get' && res && res.ok && res.data && res.data.inline) {
      showCard(d, res.data.inline);
      return;
    }
    const code = res && res.error && res.error.code;
    reply(d.id, { ok: false, code: PASS_THROUGH.has(code) ? code : 'FALLBACK' });
  }

  // ---- passkey card ---------------------------------------------------------------

  const MIN_TIMEOUT = 30000;
  const MAX_TIMEOUT = 300000;
  const EMPTY = { host: null, box: null, guard: null, d: null, timer: 0, busy: false, note: null };
  const card = { ...EMPTY };

  function closeCard() {
    clearTimeout(card.timer);
    if (card.guard) card.guard.stop();
    if (card.host) card.host.remove();
    Object.assign(card, EMPTY);
  }

  /** Close the card and let the next handler (another manager, the browser) take the request. */
  function dismiss() {
    const d = card.d;
    closeCard();
    if (d) reply(d.id, { ok: false, code: 'FALLBACK' });
  }

  function showCard(d, { rpId, candidates }) {
    if (card.d) reply(card.d.id, { ok: false, code: 'NOT_ALLOWED' }); // superseded without an abort
    closeCard();
    if (!candidates || !candidates.length) {
      reply(d.id, { ok: false, code: 'FALLBACK' });
      return;
    }
    const { el, orb } = ui;
    const { host, root } = ui.makeHost();
    const box = el('div', 'bar');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Akari — パスキーでサインイン');

    const head = el('div', 'head');
    const close = el('button', 'x', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '閉じる');
    head.append(orb(20), el('div', 'ttl', 'パスキーでサインイン'), close);

    const body = el('div', 'body');
    const list = el('div', 'pk-rows');
    list.setAttribute('role', 'list');
    const rows = [];
    for (const c of candidates) {
      const name = c.userDisplayName || c.userName || 'パスキー';
      const sub = [c.userName !== name ? c.userName : '', c.vaultName].filter(Boolean).join(' · ');
      const row = el('button', 'row');
      row.type = 'button';
      row.setAttribute('role', 'listitem');
      row.setAttribute('aria-label', `${name} でサインイン`);
      const tile = el('span', 'tile', (Array.from(name)[0] || '?').toUpperCase());
      tile.style.setProperty('--h', '30');
      const txt = el('span', 'txt');
      txt.append(el('span', 't', name));
      if (sub) txt.append(el('span', 'u', sub));
      row.append(tile, txt);
      row.addEventListener('click', (e) => {
        if (card.guard && card.guard.ok(e)) choose(c.credentialId, rows);
      });
      list.append(row);
      rows.push(row);
    }
    const msg = el('div', 'msg');
    msg.hidden = true;
    const foot = el('div', 'foot');
    foot.append(el('span', 'mark', '灯'), el('span', 'grow'));
    for (const [key, label] of [['⏎', 'サインイン'], ['esc', '閉じて他の方法']]) {
      const hint = el('span');
      hint.append(el('span', 'k', key), label);
      foot.append(hint);
    }
    body.append(el('div', 'who', rpId), list, msg, foot);
    box.append(head, body);
    root.append(box);

    close.addEventListener('click', (e) => e.isTrusted && dismiss());
    box.addEventListener('keydown', (e) => {
      if (!e.isTrusted) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        dismiss();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const i = rows.indexOf(root.activeElement);
        rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length].focus();
      }
    });

    Object.assign(card, {
      host, box, d,
      guard: ui.visibilityGuard(box, () => host),
      note: (text) => {
        msg.textContent = text;
        msg.hidden = false;
      },
    });
    // A sign-in the user started gets the keyboard; passkey autofill on page load does not.
    if (d.mediation !== 'conditional') {
      rows[0].focus({ preventScroll: true });
      const t = typeof d.options?.timeout === 'number' ? d.options.timeout : MAX_TIMEOUT;
      card.timer = setTimeout(() => {
        if (card.d !== d) return;
        closeCard();
        reply(d.id, { ok: false, code: 'NOT_ALLOWED' });
      }, Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, t)));
    }
  }

  async function choose(credentialId, rows) {
    const d = card.d;
    if (!d || card.busy) return;
    card.busy = true;
    for (const r of rows) r.disabled = true;
    let res = null;
    try {
      res = await send({ type: ASSERT, options: d.options, credentialId, requestId: d.id });
    } catch {
      /* extension reloaded: handled below */
    }
    if (card.d !== d) return; // cancelled or replaced meanwhile
    if (res && res.ok && res.data && res.data.credential) {
      reply(d.id, { ok: true, credential: res.data.credential });
      const done = ui.el('div', 'done');
      done.append(ui.el('span', 'ok', '[ ok ]'), ui.el('span', '', 'サインインしました'));
      card.box.replaceChildren(done);
      card.d = null;
      const host = card.host;
      setTimeout(() => card.host === host && closeCard(), 1200);
      return;
    }
    const code = res && res.error && res.error.code;
    if (code === 'LOCKED') {
      // Locked meanwhile: unlock in Akari's window (or leave passkey autofill to the browser).
      closeCard();
      forward(d);
      return;
    }
    card.busy = false;
    for (const r of rows) r.disabled = false;
    card.note(res ? 'サインインできませんでした' : 'Akari が更新されました — ページを再読み込みしてください');
  }

  // ---- page messages ------------------------------------------------------------------

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== ORIGIN) return;
    const d = event.data;
    if (!d || typeof d !== 'object' || d.__akari !== TAG || d.dir !== TO_EXT) return;
    if (typeof d.id !== 'string' || d.id.length > 64) return;
    if (d.action === 'cancel') {
      if (card.d && card.d.id === d.id) closeCard();
      send({ type: 'passkey/cancel', requestId: d.id }).catch(() => {});
      return;
    }
    if (!TYPES[d.action]) return;
    forward(d);
  });
})();
