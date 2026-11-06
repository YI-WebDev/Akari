// Main view: the header and list-bar labels, rebuilding the list after the visible set
// changed, the selection, and the search box.

import { S, ensureSel, visibleItems, setSearch, setSel } from '../state.js';
import { vaultColor } from '../views/format.js';
import { renderList, markSelected, scrollToRow, renderViewButton } from '../views/list.js';
import { renderDetail } from '../views/detail.js';
import { renderPicker } from '../views/picker.js';
import { editorOpen, requestClose } from '../views/editor.js';

const $ = (id) => document.getElementById(id);

export function renderVaultLabel() {
  const v = S.vaults.find((x) => x.id === S.vault);
  const all = S.vault === 'all' || !v;
  $('vaultLabel').textContent = all ? 'すべて' : v.name;
  $('vaultDot').style.background = all ? 'var(--text-soft)' : vaultColor(v.hue);
}

/** The list bar: the 表示 chip and the sort toggle. */
export function renderFilters() {
  renderViewButton();
  const sort = S.sort === 'az' ? 'A-Z' : '新着';
  $('sortBtn').textContent = sort;
  $('sortBtn').title = $('sortBtn').ariaLabel = `並び替え: ${sort}（クリックで切り替え）`;
}

/** Status bar dot: 保存中… while a change is on its way to the encrypted store. */
export function renderSaving(saving) {
  const el = $('stSave');
  el.dataset.state = saving ? 'saving' : 'saved';
  $('stSaveText').textContent = saving ? '保存中…' : '保存済み';
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
  setSearch(q);
  showQuery(q);
  refreshList();
}

/**
 * Open on the tab's site as if the user had typed it, but only when that finds something
 * (an empty list on every other site would be in the way). Esc or the clear button undoes it.
 */
export function prefillSiteQuery() {
  const q = S.siteQuery;
  if (!q || S.query) return;
  setSearch(q);
  if (!visibleItems().length) {
    setSearch('');
    return;
  }
  showQuery(q);
  ensureSel();
}
