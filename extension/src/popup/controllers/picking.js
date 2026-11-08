// Selection mode (delete several): checking rows, ranges with Shift, select all, and the delete.

import { MSG, ERR } from '../../shared/messages.js';
import { t } from '../../shared/i18n.js';
import {
  S, emit, call, errText, visibleItems, liveToken, live, setPickMode, setPicked, togglePicked, setSel,
} from '../state.js';
import { renderList, markSelected } from '../views/list.js';
import { renderDetail } from '../views/detail.js';
import { renderPicker, resetPicker, setPickerBusy } from '../views/picker.js';
import { editorOpen, requestClose } from '../views/editor.js';
import { toastError } from '../views/toast.js';
import { closeMenus } from './menus.js';

const $ = (id) => document.getElementById(id);

let pickAnchor = null; // the row last checked or unchecked: Shift+click spans from here

/** Forget the Shift+click anchor (the view was wiped on lock). */
export function resetPickAnchor() {
  pickAnchor = null;
}

export function renderPickMode() {
  $('app').toggleAttribute('data-picking', S.picking);
  $('pickBtn').setAttribute('aria-pressed', String(S.picking));
}

function enterPicking() {
  closeMenus();
  setPickMode(true);
  pickAnchor = null;
  resetPicker();
  renderPickMode();
}

/** The 選択 button, Esc: switch selection mode on or off. */
export function setPicking(on) {
  if (on === S.picking) return;
  if (on && editorOpen()) {
    requestClose(() => setPicking(true));
    return;
  }
  if (on) {
    enterPicking();
  } else {
    setPickMode(false);
    pickAnchor = null;
    resetPicker();
    renderPickMode();
  }
  renderList({ keepScroll: true });
  renderDetail({ animate: true });
}

/** Check or uncheck a row; `range` (Shift) checks every row from the last one clicked. */
export function pick(id, { range = false } = {}) {
  const entering = !S.picking;
  if (entering) {
    if (editorOpen()) {
      requestClose(() => pick(id, { range }));
      return;
    }
    const from = range ? S.sel : null; // Shift+click from the normal view spans from the open item
    enterPicking();
    pickAnchor = from;
  }
  const vis = visibleItems();
  const at = vis.findIndex((i) => i.id === id);
  if (at < 0) return;
  const from = range && pickAnchor ? vis.findIndex((i) => i.id === pickAnchor) : -1;
  if (from >= 0) {
    const [a, b] = from < at ? [from, at] : [at, from];
    setPicked(vis.slice(a, b + 1).map((i) => i.id));
  } else {
    togglePicked(id);
  }
  pickAnchor = id;
  setSel(id);
  resetPicker();
  if (entering) {
    renderList({ keepScroll: true });
    renderDetail({ animate: true });
  } else {
    markSelected();
    renderPicker();
  }
}

/** Check every visible row (Ctrl+A, すべて選択), or none. */
export function pickAll(all) {
  if (!S.picking) {
    if (editorOpen()) return;
    enterPicking();
    renderList({ keepScroll: true });
  }
  setPicked(all ? visibleItems().map((i) => i.id) : [], { replace: true });
  resetPicker();
  markSelected();
  renderDetail();
}

export async function deletePicked() {
  const ids = visibleItems().filter((i) => S.picked.has(i.id)).map((i) => i.id);
  if (!ids.length) return;
  const token = liveToken();
  setPickerBusy(true);
  try {
    const res = await call(MSG.VAULT_DELETE_ITEMS, { ids });
    if (!live(token)) return;
    setPickMode(false);
    pickAnchor = null;
    resetPicker();
    renderPickMode();
    // the list, the selection and the toast with 元に戻す: popup.js onTrashed
    emit('trashed', Array.isArray(res?.ids) ? res.ids : ids, { trash: res?.trash });
  } catch (e) {
    if (!live(token)) return;
    resetPicker();
    renderPicker();
    toastError(t('削除できませんでした'), errText(e));
    if (e?.code === ERR.NOT_FOUND) emit('reload'); // deleted elsewhere meanwhile: show what is left
  }
}
