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

export function renderFilters() {
  renderViewButton();
  const sort = S.sort === 'az' ? 'A-Z' : t('新着');
  $('sortBtn').textContent = sort;
  $('sortBtn').title = $('sortBtn').ariaLabel = t('並び替え: {sort}（クリックで切り替え）', { sort });
}

export function refreshList({ animate = false } = {}) {
  const moved = ensureSel();
  renderList({ animate, keepScroll: !animate });
  if (moved && !editorOpen()) renderDetail({ animate: true });
  else if (S.picking) renderPicker();
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
  if (!S.picking) renderDetail({ animate: true });
  if (scroll) setTimeout(() => scrollToRow(id), 0);
}

export function showQuery(q) {
  const input = $('search');
  if (input.value !== q) input.value = q;
  $('searchClear').hidden = !q;
  $('searchKey').hidden = !!q;
}

export function setQuery(q) {
  clearTimeout(typingTimer);
  setSearch(q);
  showQuery(q);
  refreshList();
}

const TYPING_MS = 50;
let typingTimer = 0;

export function typeQuery(q) {
  setSearch(q);
  showQuery(q);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => { typingTimer = 0; if (S.phase === 'main') refreshList(); }, TYPING_MS);
}

export function cancelTyping() {
  clearTimeout(typingTimer);
}

export function flushTyping() {
  if (!typingTimer) return;
  clearTimeout(typingTimer);
  typingTimer = 0;
  if (S.phase === 'main') refreshList();
}

export function prefillSiteQuery() {
  const q = S.siteQuery;
  if (!q || S.query) return;
  setSearch(q);
  if (!visibleItems().length || looseResults()) {
    setSearch('');
    return;
  }
  showQuery(q);
  ensureSel();
}
