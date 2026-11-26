(() => {
  'use strict';

  const PATH_MAX = 64;

  function middle(text, max) {
    const chars = Array.from(text);
    if (chars.length <= max) return text;
    const tail = Math.ceil((max - 1) * 0.6);
    return chars.slice(0, max - 1 - tail).join('') + '…' + chars.slice(chars.length - tail).join('');
  }

  function render(opts) {
    const { el, themed, visibilityGuard } = globalThis.__akariShadowUi;
    const { root, note = null, onClose, getHost, header = null, search = null } = opts;
    const t = opts.t || ((text) => (globalThis.__akariI18n ? globalThis.__akariI18n.t(text) : text));
    let rows = [];
    let hi = -1;
    let guard = null;
    let input = null;

    const menu = themed(el('div', 'menu'));
    menu.setAttribute('role', 'listbox');
    menu.addEventListener('mousedown', (e) => {
      if (!input || e.target !== input) e.preventDefault();
    });

    if (header) menu.appendChild(headerEl(el, header));
    if (search) {
      input = el('input', 'find');
      input.type = 'search';
      input.autocomplete = 'off';
      input.spellcheck = false;
      if (search.placeholder) {
        input.placeholder = search.placeholder;
        input.setAttribute('aria-label', search.placeholder);
      }
      if (search.value) input.value = search.value;
      input.addEventListener('input', () => {
        if (typeof search.onInput === 'function') search.onInput(input.value);
      });
      menu.appendChild(input);
    }
    const foot = el('div', 'foot');
    menu.appendChild(foot);
    let shown = [];

    function fill(rowsData, noteText) {
      for (const n of shown) n.remove();
      shown = [];
      rows = [];
      hi = -1;
      if (noteText) shown.push(el('div', 'note', noteText));
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
          if (guard && guard.ok(e)) it.choose();
        });
        shown.push(row);
        rows.push({ row, choose: it.choose });
      }
      for (const n of shown) menu.insertBefore(n, foot);
      foot.replaceChildren();
      foot.append(el('span', 'mark', '灯'), el('span', 'grow'));
      const keys = rows.length ? [['↑↓', t('選択')], ['⏎', t('入力')]] : [];
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
        if (e.isTrusted) onClose();
      });
      foot.appendChild(close);
    }

    function move(delta) {
      if (!rows.length) return;
      hi = (hi + delta + rows.length) % rows.length;
      rows.forEach((r, i) => r.row.classList.toggle('hi', i === hi));
    }

    fill(opts.rows, note);
    root.appendChild(menu);
    guard = visibilityGuard(menu, getHost);

    return Object.freeze({
      menu,
      input,
      key(e) {
        if (input && e.isComposing) return false;
        if (e.key === 'Escape') {
          onClose();
          return true;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          move(e.key === 'ArrowDown' ? 1 : -1);
          return true;
        }
        if (e.key === 'Enter' && hi >= 0 && guard && guard.ok(e)) {
          rows[hi].choose();
          return true;
        }
        return false;
      },
      setRows(rowsData, noteText = null) {
        fill(rowsData, noteText);
      },
      reset() {
        if (guard) guard.reset();
      },
      destroy() {
        if (guard) guard.stop();
        guard = null;
        menu.remove();
        rows = [];
        hi = -1;
      },
    });
  }

  function headerEl(el, header) {
    const box = el('div', 'app-id');
    if (typeof header.icon === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(header.icon)) {
      const img = el('img', 'app-ico');
      img.alt = '';
      img.src = header.icon;
      box.appendChild(img);
    }
    const txt = el('div', 'app-txt');
    if (header.name) txt.appendChild(el('div', 'app-name', header.name));
    if (header.path) {
      const p = el('div', 'app-sub', middle(String(header.path), PATH_MAX));
      p.title = String(header.path);
      txt.appendChild(p);
    }
    if (header.signer) txt.appendChild(el('div', 'app-sub', header.signer));
    if (header.field) txt.appendChild(el('div', 'app-sub', header.field));
    box.appendChild(txt);
    const out = el('div', 'app-head');
    out.appendChild(box);
    for (const w of [].concat(header.warnings || [])) {
      if (w) out.appendChild(el('div', 'app-warn', w));
    }
    return out;
  }

  globalThis.__akariMenuView = Object.freeze({ render });
})();
