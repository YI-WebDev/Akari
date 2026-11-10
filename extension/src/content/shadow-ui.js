(() => {
  'use strict';

  if (globalThis.__akariShadowUi) return;

  const FONT = 'ui-monospace, "Cascadia Mono", Consolas, "BIZ UDGothic", monospace';
  const CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
* { font-family: ${FONT}; -webkit-font-smoothing: antialiased; }
.orb, .menu, .bar {
  color-scheme: dark;
  --ak-ink-rgb: 255 214 186; --ak-wash-rgb: 255 200 160; --ak-accent-rgb: 255 122 69;
  --ak-bg: #14100D; --ak-bg-raised: #1A1511;
  --ak-text: #F2E8DE; --ak-text-2: #D7CABD; --ak-text-muted: #C4B6A7; --ak-text-dim: #AE9F90; --ak-text-faint: #938374;
  --ak-accent: #FF7A45; --ak-accent-strong: #FF9A6E; --ak-accent-hover: #FF9A6E; --ak-on-accent: #14100D;
  --ak-accent-select: rgb(var(--ak-accent-rgb) / .11); --ak-accent-tint-border: rgb(var(--ak-accent-rgb) / .45);
  --ak-accent-line: rgb(var(--ak-accent-rgb) / .55);
  --ak-surface-hover: rgb(var(--ak-wash-rgb) / .05);
  --ak-menu-ring: rgb(var(--ak-ink-rgb) / .14); --ak-border-strong: rgb(var(--ak-ink-rgb) / .16);
  --ak-scrollbar: rgb(var(--ak-ink-rgb) / .16);
  --ak-success: #9BD67E; --ak-danger: #FF6B5B;
  --ak-tile-l: 0.85; --ak-tile-c: 0.11; --ak-tile-bg-l: 0.72; --ak-tile-bg-c: 0.12;
  --ak-shadow-menu: 0 18px 40px rgb(0 0 0 / .55);
}
:is(.orb, .menu, .bar).light {
  color-scheme: light;
  --ak-ink-rgb: 74 50 32; --ak-wash-rgb: 120 72 40; --ak-accent-rgb: 224 90 34;
  --ak-bg: #F6F0E8; --ak-bg-raised: #FBF7F1;
  --ak-text: #261B13; --ak-text-2: #3F3127; --ak-text-muted: #514236; --ak-text-dim: #5E4E41; --ak-text-faint: #716050;
  --ak-accent: #E05A22; --ak-accent-strong: #AE4317; --ak-accent-hover: #EC7440; --ak-on-accent: #1F150E;
  --ak-surface-hover: rgb(var(--ak-wash-rgb) / .06);
  --ak-menu-ring: rgb(var(--ak-ink-rgb) / .16); --ak-border-strong: rgb(var(--ak-ink-rgb) / .22);
  --ak-scrollbar: rgb(var(--ak-ink-rgb) / .22);
  --ak-success: #2F6E1C; --ak-danger: #B8301F;
  --ak-tile-l: 0.48; --ak-tile-c: 0.12; --ak-tile-bg-l: 0.7; --ak-tile-bg-c: 0.12;
  --ak-shadow-menu: 0 18px 40px rgb(74 50 32 / .18);
}
.orb { position: fixed; display: block; margin: 0; padding: 0; border: 0; border-radius: 5px; cursor: pointer;
  background: var(--ak-accent); color: var(--ak-on-accent); font-weight: 700; text-align: center; transition: background-color .15s; }
.orb:hover { background: var(--ak-accent-hover); }
.menu { position: fixed; min-width: 260px; background: var(--ak-bg-raised); color: var(--ak-text); border-radius: 8px; padding: 6px;
  border: 1px solid var(--ak-menu-ring); box-shadow: var(--ak-shadow-menu); font-size: 12px; line-height: 1.45;
  animation: in .18s cubic-bezier(.2, .9, .2, 1) both; max-height: 60vh; overflow: auto;
  scrollbar-width: thin; scrollbar-color: var(--ak-scrollbar) transparent; }
.row { position: relative; display: flex; align-items: center; gap: 10px; height: 42px; padding: 0 10px 0 16px;
  border-radius: 5px; cursor: pointer; transition: background .15s; }
.row::before { content: '›'; position: absolute; left: 5px; top: 13px; height: 16px; line-height: 16px; color: var(--ak-accent);
  font-size: 13px; font-weight: 700; opacity: 0; transform: translateX(-4px); transition: opacity .15s, transform .25s cubic-bezier(.22, 1, .36, 1); }
.row:hover { background: var(--ak-surface-hover); }
.row.hi { background: var(--ak-accent-select); box-shadow: inset 0 0 0 1px rgb(var(--ak-accent-rgb) / .3); }
.row:hover::before, .row.hi::before { opacity: 1; transform: none; }
.tile { flex: none; width: 28px; height: 28px; border-radius: 6px; display: grid; place-items: center; font-weight: 700; font-size: 12px;
  background: oklch(var(--ak-tile-bg-l) var(--ak-tile-bg-c) var(--h, 55) / .13);
  border: 1px solid oklch(var(--ak-tile-bg-l) var(--ak-tile-bg-c) var(--h, 55) / .32);
  color: oklch(var(--ak-tile-l) var(--ak-tile-c) var(--h, 55)); }
.txt { min-width: 0; display: flex; flex-direction: column; }
.t { font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.u { color: var(--ak-text-dim); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.note { padding: 8px 10px; color: var(--ak-text-muted); font-size: 11px; line-height: 1.55; }
.note::before { content: '! '; color: var(--ak-accent); font-weight: 700; }
.foot { display: flex; align-items: center; gap: 10px; margin-top: 4px; padding: 6px 4px 1px; border-top: 1px solid rgb(var(--ak-ink-rgb) / .08);
  color: var(--ak-text-faint); font-size: 11px; line-height: 16px; white-space: nowrap; }
.mark { flex: none; width: 16px; height: 16px; border-radius: 4px; background: var(--ak-accent); color: var(--ak-on-accent); font-size: 11px;
  font-weight: 700; line-height: 16px; text-align: center; }
.grow { flex: 1; }
.k { display: inline-block; margin-right: 4px; padding: 0 4px; border: 1px solid var(--ak-menu-ring); border-radius: 3px; color: var(--ak-text-muted);
  line-height: 14px; }
.bar { position: fixed; top: 16px; right: 16px; width: 340px; max-width: calc(100vw - 32px); background: var(--ak-bg); color: var(--ak-text);
  border: 1px solid var(--ak-menu-ring); border-radius: 8px; overflow: hidden; font-size: 12px; line-height: 1.45;
  box-shadow: var(--ak-shadow-menu); animation: in .22s cubic-bezier(.2, .9, .2, 1) both; }
.head { height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 12px; background: var(--ak-bg-raised);
  border-bottom: 1px solid rgb(var(--ak-ink-rgb) / .09); }
.head .orb { position: static; flex: none; cursor: default; }
.head .orb:hover { background: var(--ak-accent); }
.ttl { min-width: 0; font-size: 12.5px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tag { flex: none; margin-left: auto; padding: 0 6px; border: 1px solid var(--ak-accent-tint-border); border-radius: 4px;
  background: rgb(var(--ak-accent-rgb) / .08); color: var(--ak-accent-strong); font-size: 11px; line-height: 18px; }
.body { padding: 12px; }
.who { color: var(--ak-text-2); font-size: 11.5px; line-height: 16px; overflow-wrap: anywhere; }
.kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; margin: 0; }
.kv dt { color: var(--ak-text-faint); font-size: 11px; line-height: 18px; }
.kv dd { margin: 0; color: var(--ak-text-2); font-size: 12px; line-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kv .none { color: var(--ak-text-faint); }
.msg { margin-top: 6px; color: var(--ak-danger); font-size: 11px; line-height: 16px; overflow-wrap: anywhere; }
.btns { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.btn { height: 32px; padding: 0 14px; border: 1px solid transparent; border-radius: 5px; font-size: 12px; cursor: pointer; white-space: nowrap;
  transition: border-color .15s, background .15s, box-shadow .2s, color .15s; }
.btn:disabled { opacity: .5; cursor: default; }
.btn:focus-visible { outline: none; box-shadow: 0 0 0 3px rgb(var(--ak-accent-rgb) / .35); }
.primary { min-width: 76px; background: var(--ak-accent); color: var(--ak-on-accent); font-weight: 700; }
.primary:hover:not(:disabled) { background: var(--ak-accent-hover); }
.ghost { background: transparent; color: var(--ak-text-muted); border-color: var(--ak-border-strong); }
.ghost:hover:not(:disabled) { border-color: var(--ak-accent-line); background: rgb(var(--ak-accent-rgb) / .06); color: var(--ak-text); }
.done { display: flex; align-items: center; gap: 8px; padding: 12px; font-size: 12px; font-weight: 700; }
.ok { color: var(--ak-success); font-weight: 400; }
.x { flex: none; margin-left: auto; width: 24px; height: 24px; padding: 0; display: grid; place-items: center; border: 1px solid transparent;
  border-radius: 5px; background: transparent; color: var(--ak-text-muted); font-size: 15px; line-height: 1; cursor: pointer; transition: border-color .15s, color .15s; }
.x:hover, .x:focus-visible { outline: none; border-color: var(--ak-accent-line); color: var(--ak-text); }
.x-sm { margin-left: 0; width: 18px; height: 18px; font-size: 13px; border-radius: 3px; }
.pk-rows { display: flex; flex-direction: column; gap: 2px; margin: 8px -6px 0; max-height: 50vh; overflow: auto;
  scrollbar-width: thin; scrollbar-color: var(--ak-scrollbar) transparent; }
.pk-rows .row { width: 100%; margin: 0; border: 0; background: transparent; color: inherit; text-align: left; font-size: 12px; }
.pk-rows .row:focus-visible { outline: none; background: var(--ak-accent-select); box-shadow: inset 0 0 0 1px rgb(var(--ak-accent-rgb) / .3); }
.pk-rows .row:focus-visible::before { opacity: 1; transform: none; }
.pk-rows .row:disabled { cursor: default; opacity: .55; }
.bar .foot { margin-top: 8px; padding: 8px 0 0; }
.bar .note { margin-top: 8px; padding: 0; }
.acct { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; }
.lbl { margin-right: 2px; color: var(--ak-text-faint); font-size: 11px; }
.chip { height: 24px; padding: 0 10px; border: 1px solid var(--ak-border-strong); border-radius: 4px; background: transparent;
  color: var(--ak-text-muted); font-size: 11px; cursor: pointer; transition: border-color .15s, background .15s, color .15s; }
.chip:hover:not(:disabled) { border-color: var(--ak-accent-line); color: var(--ak-text); }
.chip[aria-pressed="true"] { border-color: oklch(var(--ak-tile-bg-l) var(--ak-tile-bg-c) var(--h, 55) / .6);
  background: oklch(var(--ak-tile-bg-l) var(--ak-tile-bg-c) var(--h, 55) / .14); color: var(--ak-text); }
.chip:focus-visible { outline: none; box-shadow: 0 0 0 3px rgb(var(--ak-accent-rgb) / .35); }
.chip:disabled { opacity: .5; cursor: default; }
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

  const isLight = () => {
    try {
      return globalThis.__akariI18n?.theme?.() === 'light';
    } catch {
      return false;
    }
  };

  function themed(node) {
    node.classList.toggle('light', isLight());
    return node;
  }

  function orb(size) {
    const b = themed(el('button', 'orb', '灯'));
    b.type = 'button';
    b.tabIndex = -1;
    b.setAttribute('aria-label', 'Akari');
    b.style.width = b.style.height = b.style.lineHeight = size + 'px';
    b.style.fontSize = Math.max(11, Math.round(size * 0.58)) + 'px';
    b.addEventListener('mousedown', (e) => e.preventDefault());
    return b;
  }

  const VISIBLE_MS = 500;
  const MIN_VISIBLE_RATIO = 0.5;
  const OCCLUSION_CHECK_DELAY_MS = 100;

  function visibilityGuard(target, getHost) {
    let visibleSince = 0;
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1];
        visibleSince = e.isIntersecting && e.isVisible && e.intersectionRatio >= MIN_VISIBLE_RATIO ? visibleSince || performance.now() : 0;
      },
      { threshold: [0, MIN_VISIBLE_RATIO, 1], trackVisibility: true, delay: OCCLUSION_CHECK_DELAY_MS },
    );
    io.observe(target);
    const opaque = (n) => parseFloat(getComputedStyle(n).opacity) >= 1;
    return {
      reset() {
        if (visibleSince) visibleSince = performance.now();
      },
      ok(e) {
        if (!e.isTrusted || document.visibilityState !== 'visible') return false;
        if (!visibleSince || performance.now() - visibleSince < VISIBLE_MS) return false;
        const host = getHost();
        if (!host || !host.isConnected) return false;
        for (let n = host; n; n = n.parentElement) if (!opaque(n)) return false;
        if (document.body && !opaque(document.body)) return false;
        const isPointerClick = e.type === 'click' && e.detail !== 0;
        if (isPointerClick && document.elementFromPoint(e.clientX, e.clientY) !== host) return false;
        return true;
      },
      stop() {
        io.disconnect();
        visibleSince = 0;
      },
    };
  }

  const SIGHT_SETTLE_CAP_MS = 2000;

  function sightWatch(targets) {
    const seen = new WeakSet();
    const pending = new Map();
    let ready = false;
    let settle = null;
    const settled = new Promise((resolve) => {
      settle = () => {
        ready = true;
        resolve();
      };
    });
    const cap = setTimeout(settle, SIGHT_SETTLE_CAP_MS);
    let afterFirstLook = 0;
    const io = new IntersectionObserver(
      (entries) => {
        if (!afterFirstLook) afterFirstLook = setTimeout(settle, VISIBLE_MS + OCCLUSION_CHECK_DELAY_MS);
        for (const e of entries) {
          const visible = e.isIntersecting && e.isVisible && e.intersectionRatio >= MIN_VISIBLE_RATIO;
          if (!visible) {
            clearTimeout(pending.get(e.target));
            pending.delete(e.target);
          } else if (!seen.has(e.target) && !pending.has(e.target)) {
            pending.set(e.target, setTimeout(() => {
              pending.delete(e.target);
              seen.add(e.target);
            }, VISIBLE_MS));
          }
        }
      },
      { threshold: [0, MIN_VISIBLE_RATIO, 1], trackVisibility: true, delay: OCCLUSION_CHECK_DELAY_MS },
    );
    for (const target of targets) io.observe(target);
    if (!targets.length) settle();
    return {
      seen: (target) => seen.has(target),
      ready: () => ready,
      settled,
      stop() {
        io.disconnect();
        clearTimeout(cap);
        clearTimeout(afterFirstLook);
        for (const timer of pending.values()) clearTimeout(timer);
        pending.clear();
        settle();
      },
    };
  }

  globalThis.__akariShadowUi = Object.freeze({ makeHost, el, orb, themed, visibilityGuard, sightWatch });
})();
