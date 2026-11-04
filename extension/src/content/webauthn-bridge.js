// Akari WebAuthn bridge (ISOLATED world, top frame). Classic script; uses the in-page UI kit
// (shadow-ui.js, loaded just before it). Relays requests from webauthn-page.js (MAIN world)
// to the service worker and the answers back. The service worker derives the origin from
// the sender, so nothing the page claims about its origin is trusted.
//
// While Akari is unlocked, sign-in and saving a passkey happen on a card in the page: the
// service worker says what to show (the site's passkeys, or the account to save), and a
// trusted click on the card (once it has been plainly visible for a moment) asks it to sign
// or to create. Closing the card hands the request to whatever is next (another passkey
// manager, or the browser). The page only ever gets the credential.
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
  const SAVE = 'passkey/save';
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
    if (res && res.ok && res.data && res.data.inline) {
      if (d.action === 'get') showSignIn(d, res.data.inline);
      else showSave(d, res.data.inline);
      return;
    }
    const code = res && res.error && res.error.code;
    reply(d.id, { ok: false, code: PASS_THROUGH.has(code) ? code : 'FALLBACK' });
  }

  // ---- the card -------------------------------------------------------------------

  const MIN_TIMEOUT = 30000;
  const MAX_TIMEOUT = 300000;
  const EMPTY = { host: null, root: null, box: null, guard: null, d: null, timer: 0, busy: false, note: null, controls: [] };
  const card = { ...EMPTY };

  const initial = (name) => (Array.from(name)[0] || '?').toUpperCase();

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

  /** A card at the top right with a title bar (× and Esc hand the request on); returns its body. */
  function openCard(d, title) {
    if (card.d) reply(card.d.id, { ok: false, code: 'NOT_ALLOWED' }); // superseded without an abort
    closeCard();
    const { el, orb } = ui;
    const { host, root } = ui.makeHost();
    const box = el('div', 'bar');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Akari — ' + title);

    const head = el('div', 'head');
    const close = el('button', 'x', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '閉じる');
    head.append(orb(20), el('div', 'ttl', title), close);
    const body = el('div', 'body');
    const msg = el('div', 'msg');
    msg.hidden = true;
    box.append(head, body);
    root.append(box);

    close.addEventListener('click', (e) => e.isTrusted && dismiss());
    box.addEventListener('keydown', (e) => {
      if (e.isTrusted && e.key === 'Escape') {
        e.preventDefault();
        dismiss();
      }
    });
    Object.assign(card, {
      host, root, box, d,
      guard: ui.visibilityGuard(box, () => host),
      note: (text) => {
        msg.textContent = text;
        msg.hidden = false;
      },
    });
    return { body, msg };
  }

  function foot(hints) {
    const { el } = ui;
    const f = el('div', 'foot');
    f.append(el('span', 'mark', '灯'), el('span', 'grow'));
    for (const [key, label] of hints) {
      const hint = el('span');
      hint.append(el('span', 'k', key), label);
      f.append(hint);
    }
    return f;
  }

  /** A request the user started gets the keyboard and a timeout; passkey autofill on page load does not. */
  function takeFocus(d, target) {
    if (d.mediation === 'conditional') return;
    target.focus({ preventScroll: true });
    const t = typeof d.options?.timeout === 'number' ? d.options.timeout : MAX_TIMEOUT;
    card.timer = setTimeout(() => {
      if (card.d !== d) return;
      closeCard();
      reply(d.id, { ok: false, code: 'NOT_ALLOWED' });
    }, Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, t)));
  }

  /** An account line: initial tile, name, and a muted second line. */
  function account(cls, name, sub) {
    const { el } = ui;
    const line = el(cls === 'row' ? 'button' : 'div', cls);
    const tile = el('span', 'tile', initial(name));
    tile.style.setProperty('--h', '30');
    const txt = el('span', 'txt');
    txt.append(el('span', 't', name));
    if (sub) txt.append(el('span', 'u', sub));
    line.append(tile, txt);
    return line;
  }

  function showSignIn(d, { rpId, candidates }) {
    if (!candidates || !candidates.length) {
      reply(d.id, { ok: false, code: 'FALLBACK' });
      return;
    }
    const { el } = ui;
    const { body, msg } = openCard(d, 'パスキーでサインイン');
    const list = el('div', 'pk-rows');
    list.setAttribute('role', 'list');
    const rows = [];
    for (const c of candidates) {
      const name = c.userDisplayName || c.userName || 'パスキー';
      const sub = [c.userName !== name ? c.userName : '', c.vaultName].filter(Boolean).join(' · ');
      const row = account('row', name, sub);
      row.type = 'button';
      row.setAttribute('role', 'listitem');
      row.setAttribute('aria-label', `${name} でサインイン`);
      row.addEventListener('click', (e) => {
        if (card.guard && card.guard.ok(e)) {
          act({ type: ASSERT, options: d.options, credentialId: c.credentialId, requestId: d.id }, 'サインインしました', 'サインインできませんでした');
        }
      });
      list.append(row);
      rows.push(row);
    }
    list.addEventListener('keydown', (e) => {
      if (!e.isTrusted || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      e.preventDefault();
      const i = rows.indexOf(card.root.activeElement);
      rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length].focus();
    });
    body.append(el('div', 'who', rpId), list, msg, foot([['⏎', 'サインイン'], ['esc', '閉じて他の方法']]));
    card.controls = rows;
    takeFocus(d, rows[0]);
  }

  function showSave(d, info) {
    const { el } = ui;
    const { body, msg } = openCard(d, 'パスキーを保存');
    const user = info.user || {};
    const vaults = Array.isArray(info.vaults) ? info.vaults : [];
    body.append(el('div', 'who', info.rpName && info.rpName !== info.rpId ? `${info.rpName} · ${info.rpId}` : info.rpId));

    const primary = el('button', 'btn primary');
    primary.type = 'button';
    const btns = el('div', 'btns');
    btns.append(primary);

    if (info.excluded) {
      // Told only after the user acts, so the page cannot probe what Akari holds.
      body.append(el('div', 'note', 'このアカウントのパスキーは Akari に保存済みです'));
      primary.textContent = 'OK';
      primary.addEventListener('click', (e) => {
        if (!card.guard || !card.guard.ok(e) || card.d !== d) return;
        closeCard();
        reply(d.id, { ok: false, code: 'INVALID_STATE' });
      });
      card.controls = [primary];
    } else {
      const name = user.displayName || user.name || 'パスキー';
      let chosen = info.defaultVault;
      const single = vaults.length === 1 ? vaults[0].name : '';
      body.append(account('acct', name, [user.name !== name ? user.name : '', single].filter(Boolean).join(' · ')));
      const chips = [];
      if (vaults.length > 1) {
        const row = el('div', 'chips');
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', '保存先の保管庫');
        row.append(el('span', 'lbl', '保存先'));
        for (const v of vaults) {
          const chip = el('button', 'chip', v.name);
          chip.type = 'button';
          chip.style.setProperty('--h', String(Number.isFinite(v.hue) ? v.hue : 55));
          chip.setAttribute('aria-pressed', String(v.id === chosen));
          chip.addEventListener('click', (e) => {
            if (!e.isTrusted) return;
            chosen = v.id;
            for (const c of chips) c.setAttribute('aria-pressed', String(c === chip));
          });
          row.append(chip);
          chips.push(chip);
        }
        body.append(row);
      }
      primary.textContent = '保存';
      primary.addEventListener('click', (e) => {
        if (card.guard && card.guard.ok(e)) {
          act({ type: SAVE, options: d.options, vault: chosen, requestId: d.id }, 'パスキーを保存しました', '保存できませんでした');
        }
      });
      card.controls = [primary, ...chips];
    }
    body.append(msg, btns, foot([['⏎', info.excluded ? 'OK' : '保存'], ['esc', '閉じて他の方法']]));
    takeFocus(d, primary);
  }

  /** After a trusted click on the card: ask the service worker for the credential and answer the page. */
  async function act(message, doneText, failText) {
    const d = card.d;
    if (!d || card.busy) return;
    card.busy = true;
    for (const c of card.controls) c.disabled = true;
    let res = null;
    try {
      res = await send(message);
    } catch {
      /* extension reloaded: handled below */
    }
    if (card.d !== d) return; // cancelled or replaced meanwhile
    if (res && res.ok && res.data && res.data.credential) {
      reply(d.id, { ok: true, credential: res.data.credential });
      const done = ui.el('div', 'done');
      done.append(ui.el('span', 'ok', '[ ok ]'), ui.el('span', '', doneText));
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
    if (code === 'INVALID_STATE') {
      // Saved meanwhile (another tab): the site asked not to register twice.
      closeCard();
      reply(d.id, { ok: false, code });
      return;
    }
    card.busy = false;
    for (const c of card.controls) c.disabled = false;
    card.note(res ? failText : 'Akari が更新されました — ページを再読み込みしてください');
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
