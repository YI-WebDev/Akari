// Main view: the header and list-bar labels, rebuilding the list after the visible set
// changed, the selection, and the search box.

import { t } from '../../shared/i18n.js';
import { S, ensureSel, visibleItems, looseResults, setSearch, setSel } from '../state.js';
import { vaultColor } from '../views/format.js';
import { renderList, markSelected, scrollToRow, renderViewButton } from '../views/list.js';
import { renderDetail } from '../views/detail.js';
import { renderPicker } from '../views/picker.js';
import { editorOpen, requestClose } from '../views/editor.js';

const $ = (id) => document.getElementById(id);

export function renderVaultLabel() {
  const v = S.vaults.find((x) => x.id === S.vault);
  const all = S.vault === 'all' || !v;
  $('vaultLabel').textContent = all ? t('すべて') : v.name;
  $('vaultDot').style.background = all ? 'var(--text-soft)' : vaultColor(v.hue);
}

/** The list bar: the 表示 chip and the sort toggle. */
export function renderFilters() {
  renderViewButton();
  const sort = S.sort === 'az' ? 'A-Z' : t('新着');
  $('sortBtn').textContent = sort;
  $('sortBtn').title = $('sortBtn').ariaLabel = t('並び替え: {sort}（クリックで切り替え）', { sort });
}

/** Rebuild list (and detail if the selection moved) after the visible set changed. Returns whether it moved. */
export function refreshList({ animate = false } = {}) {
  const moved = ensureSel();
  renderList({ animate, keepScroll: !animate });
  if (moved && !editorOpen()) renderDetail({ animate: true });
  else if (S.picking) renderPicker(); // the count of rows to "select all" may have changed
  return moved;
}

export function select(id, { scroll = false } = {}) {
  if (!id) return;
  if (editorOpen()) {
    requestClose(() => doSelect(id, scroll, true));
    return;
  }
  doSelect(id, scroll, false);
}

function doSelect(id, scroll, force) {
  if (id === S.sel && !force) return;
  setSel(id);
  markSelected();
  if (!S.picking) renderDetail({ animate: true }); // in selection mode ↑↓ only move the keyboard row
  if (scroll) setTimeout(() => scrollToRow(id), 0);
}

/** The search box shows `q` (its clear button / `/` hint follow); does not search. */
export function showQuery(q) {
  const input = $('search');
  if (input.value !== q) input.value = q;
  $('searchClear').hidden = !q;
  $('searchKey').hidden = !!q;
}

/** Search for `q` and show it in the search box. */
export function setQuery(q) {
  clearTimeout(typingTimer);
  setSearch(q);
  showQuery(q);
  refreshList();
}

// Typing: the query takes effect at once (↑↓ and ⏎ follow it), the list is redrawn once the keys
// pause for TYPING_MS, so a fast typist does not rebuild it on every key.
const TYPING_MS = 50;
let typingTimer = 0;

/** The search box's own input. */
export function typeQuery(q) {
  setSearch(q);
  showQuery(q);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => { typingTimer = 0; if (S.phase === 'main') refreshList(); }, TYPING_MS);
}

/** Drop a redraw that is still waiting (lock). */
export function cancelTyping() {
  clearTimeout(typingTimer);
}

/** Redraw now if typing left one waiting: ↑↓ and ⏎ act on the list the user sees. */
export function flushTyping() {
  if (!typingTimer) return;
  clearTimeout(typingTimer);
  typingTimer = 0;
  if (S.phase === 'main') refreshList();
}

/**
 * Open on the tab's site as if the user had typed it, but only when that finds something
 * (an empty list on every other site would be in the way). Esc or the clear button undoes it.
 */
export function prefillSiteQuery() {
  const q = S.siteQuery;
  if (!q || S.query) return;
  setSearch(q);
  // a near match (the letters in order) is not this site's login
  if (!visibleItems().length || looseResults()) {
    setSearch('');
    return;
  }
  showQuery(q);
  ensureSel();
}
