// Akari's in-page UI kit (ISOLATED world). Classic script, loaded before autofill.js and
// webauthn-bridge.js. Content scripts of one extension share an isolated world per frame,
// so the first copy to run defines globalThis.__akariShadowUi and later copies return.
//
// Everything is built in CLOSED shadow roots with textContent only: the page can neither
// read what Akari shows nor inject markup into it.

(() => {
  'use strict';

  if (globalThis.__akariShadowUi) return;

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
.x { flex: none; margin-left: auto; width: 24px; height: 24px; padding: 0; display: grid; place-items: center; border: 1px solid transparent;
  border-radius: 5px; background: transparent; color: #9C8D7F; font-size: 15px; line-height: 1; cursor: pointer; transition: border-color .15s, color .15s; }
.x:hover, .x:focus-visible { outline: none; border-color: rgba(255, 122, 69, .55); color: #F2E8DE; }
.pk-rows { display: flex; flex-direction: column; gap: 2px; margin: 8px -6px 0; max-height: 50vh; overflow: auto;
  scrollbar-width: thin; scrollbar-color: rgba(255, 214, 186, .16) transparent; }
.pk-rows .row { width: 100%; margin: 0; border: 0; background: transparent; color: inherit; text-align: left; font-size: 12px; }
.pk-rows .row:focus-visible { outline: none; background: rgba(255, 122, 69, .11); box-shadow: inset 0 0 0 1px rgba(255, 122, 69, .3); }
.pk-rows .row:focus-visible::before { opacity: 1; transform: none; }
.pk-rows .row:disabled { cursor: default; opacity: .55; }
.bar .foot { margin-top: 8px; padding: 8px 0 0; }
.bar .note { margin-top: 8px; padding: 0; }
.acct { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; }
.lbl { margin-right: 2px; color: #8A7B6D; font-size: 10.5px; }
.chip { height: 24px; padding: 0 10px; border: 1px solid rgba(255, 214, 186, .16); border-radius: 12px; background: transparent;
  color: #B9AA9B; font-size: 11px; cursor: pointer; transition: border-color .15s, background .15s, color .15s; }
.chip:hover:not(:disabled) { border-color: rgba(255, 122, 69, .55); color: #F2E8DE; }
.chip[aria-pressed="true"] { border-color: oklch(0.72 0.12 var(--h, 55) / .6); background: oklch(0.72 0.12 var(--h, 55) / .14); color: #F2E8DE; }
.chip:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(255, 122, 69, .35); }
.chip:disabled { opacity: .5; cursor: default; }
@keyframes in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;
  let sheet = null;

  /** A zero-size, top-most host with a closed shadow root for one piece of UI. */
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
  // So a click/Enter on Akari's UI only counts after IntersectionObserver v2 has reported the element truly
  // visible (not occluded, no opacity/filter/transform tricks) for VISIBLE_MS without a move, the tab is
  // visible, nothing in the ancestor chain is translucent and, for mouse clicks, our own host is what is
  // really under the pointer.

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

  globalThis.__akariShadowUi = Object.freeze({ makeHost, el, orb, visibilityGuard });
})();
