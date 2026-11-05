// Popup-wide keys: Esc (close the top layer), / (search), ↑↓ (move), ⏎ (copy the secret),
// and selection mode's Ctrl+A / space / Delete.

import { typeOf, hasTemplate, fieldLabel } from '../../shared/item-types.js';
import { S, visibleItems, itemById, copyText } from '../state.js';
import { editorOpen, requestClose } from '../views/editor.js';
import { closeGenerator, isGenOpen } from '../views/generator.js';
import { closeSettings, isSettingsOpen } from '../views/settings.js';
import { closeHealth, isHealthOpen } from '../views/health.js';
import { gateOpen } from '../views/lock.js';
import { askDelete, pickerConfirming, resetPicker, renderPicker } from '../views/picker.js';
import { MENUS, closeMenus, menuOpen, openMenuKey } from './menus.js';
import { setPicking, pick, pickAll } from './picking.js';
import { select, setQuery } from './view.js';

const $ = (id) => document.getElementById(id);

export function onKey(e) {
  // keys that confirm/cancel Japanese IME conversion must not trigger shortcuts
  if (e.isComposing || e.keyCode === 229) return;
  if (S.phase !== 'main' || gateOpen()) return;
  const ae = document.activeElement;
  const typing = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
  const search = $('search');

  if (e.key === 'Escape') {
    if (isGenOpen()) { closeGenerator(); e.preventDefault(); return; }
    if (isSettingsOpen()) { closeSettings(); e.preventDefault(); return; }
    if (isHealthOpen()) { closeHealth(); e.preventDefault(); return; }
    if (menuOpen()) {
      const which = openMenuKey();
      closeMenus();
      $(MENUS[which][0]).focus();
      e.preventDefault();
      return;
    }
    if (editorOpen()) { requestClose(); e.preventDefault(); return; }
    if (S.picking && pickerConfirming()) { resetPicker(); renderPicker(); e.preventDefault(); return; }
    // In the search box Esc clears the query first; otherwise it leaves selection mode.
    if (S.picking && !(ae === search && S.query)) { setPicking(false); e.preventDefault(); return; }
    if (S.query) { setQuery(''); e.preventDefault(); return; }
    if (typing) ae.blur();
    return;
  }
  if (isGenOpen() || isSettingsOpen() || isHealthOpen() || menuOpen()) return;
  if (e.key === '/' && !typing) {
    e.preventDefault();
    search.focus();
    search.select();
    return;
  }
  if (editorOpen()) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a' && !typing) {
    e.preventDefault();
    pickAll(true);
    return;
  }
  if (S.picking && !typing) {
    if (e.key === ' ' && !(ae && ae.tagName === 'BUTTON')) {
      e.preventDefault();
      if (S.sel) pick(S.sel);
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      askDelete();
      return;
    }
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (typing && ae !== search) return;
    const v = visibleItems();
    if (!v.length) return;
    e.preventDefault();
    let i = v.findIndex((x) => x.id === S.sel);
    i = e.key === 'ArrowDown' ? Math.min(v.length - 1, i + 1) : Math.max(0, i - 1);
    select(v[i].id, { scroll: true });
    return;
  }
  if (e.key === 'Enter') {
    if (typing && ae !== search) return;
    if (ae && (ae.tagName === 'BUTTON' || ae.tagName === 'A')) return;
    if (S.picking) return; // no password copy while choosing what to delete
    const target = primarySecret(itemById(S.sel));
    if (!target) return;
    e.preventDefault();
    if (typing) ae.blur();
    copyText(target.field, target.value, target.opts);
  }
}

/** What ⏎ copies: a login's password, or the first filled single-line secret of a templated item. */
function primarySecret(it) {
  if (!it) return null;
  if (it.type === 'login') return it.password ? { field: 'pass', value: it.password } : null;
  if (!hasTemplate(it.type)) return null;
  for (const fd of typeOf(it.type).fields) {
    const v = it.fields?.[fd.key];
    if (fd.kind !== 'secret' || !v) continue;
    const value = fd.format === 'card' ? String(v).replace(/\D/g, '') : String(v);
    return { field: fd.key, value, opts: { label: fieldLabel(it.type, fd.key), secret: true } };
  }
  return null;
}
