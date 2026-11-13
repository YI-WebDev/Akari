import { MSG, ATTACHMENT_LIMITS } from '../../shared/messages.js';
import { t } from '../../shared/i18n.js';
import { toB64, fromB64 } from '../../shared/bytes.js';
import { call, errText, liveToken, live, attachmentUsage } from '../state.js';
import { h, clear, icon } from './dom.js';
import { downloadFile, safeFileName } from './io.js';
import { formatDate } from './format.js';
import { rise } from './fx.js';
import { toast, toastError } from './toast.js';

const MiB = 1024 * 1024;
const MAX_NAME = 255;
const NAME_IN_MESSAGE = 40;
const LOW_SPACE = 2 * ATTACHMENT_LIMITS.fileBytes;
const PREVIEW_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif|tiff?)$/i;

const limitMb = () => Math.round(ATTACHMENT_LIMITS.fileBytes / MiB);
const perItem = ATTACHMENT_LIMITS.perItem;

export function formatSize(n) {
  const b = Math.max(0, Number(n) || 0);
  if (b < 1024) return `${b} B`;
  if (b < MiB) return `${(b / 1024).toFixed(b < 10 * 1024 ? 1 : 0)} KB`;
  return `${(b / MiB).toFixed(1)} MB`;
}

function extOf(name) {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''))?.[1];
  return ext ? `.${ext}` : t('attach.kindFile', null, 'ファイル');
}

const isImage = (name, mime) => /^image\//i.test(String(mime || '')) || IMAGE_EXT.test(String(name || ''));
const fileIcon = (name, mime) => icon(isImage(name, mime) ? 'image' : 'file', 14);

const short = (name) => {
  const s = String(name || '');
  return s.length > NAME_IN_MESSAGE ? `${s.slice(0, NAME_IN_MESSAGE - 1)}…` : s;
};

function storeName(name) {
  const s = String(name || '').trim() || 'file';
  if (s.length <= MAX_NAME) return s;
  const ext = /\.[a-z0-9]{1,8}$/i.exec(s)?.[0] || '';
  return s.slice(0, MAX_NAME - ext.length) + ext;
}

function usage() {
  try {
    const u = attachmentUsage();
    if (u && Number.isFinite(u.used) && Number.isFinite(u.limit)) return u;
  } catch {}
  return { used: 0, limit: ATTACHMENT_LIMITS.totalBytes };
}

function announcer() {
  const el = h('div', { class: 'at-live', role: 'status', 'aria-live': 'polite' });
  let timer = 0;
  const say = (msg) => {
    clearTimeout(timer);
    el.textContent = '';
    timer = setTimeout(() => { el.textContent = msg; }, 60);
  };
  return { el, say, stop: () => clearTimeout(timer) };
}

const tag = (glyph, cls) => h('span', { class: `at-tag ${cls}`, 'aria-hidden': 'true' }, glyph);

function editRow({ name, mime }) {
  const meta = h('span', { class: 'at-meta' });
  const acts = h('span', { class: 'at-acts' });
  const row = h('div', { class: 'at-item', role: 'listitem' },
    h('span', { class: 'at-ico', 'aria-hidden': 'true' }, fileIcon(name, mime)),
    h('span', { class: 'at-text' }, h('span', { class: 'at-name', title: name }, name), meta),
    acts);
  return { row, meta, acts };
}

export function createAttachmentsEditor({ item = null, onDirty = () => {} } = {}) {
  const sr = announcer();
  const stored = [];
  const queue = [];
  let busy = false;
  let uid = 0;

  const count = h('span', { class: 'ed-sect-count' });
  const note = h('span', { class: 'ed-sect-note' });
  const list = h('div', { class: 'at-list', role: 'list', 'aria-label': t('attach.title', null, '添付ファイル') });
  const err = h('div', { class: 'field-err at-err', role: 'alert' });
  const input = h('input', { type: 'file', multiple: true, class: 'at-input' });
  const main = h('span', { class: 'ed-slot-main' });
  const sub = h('span', { class: 'ed-slot-sub' });
  const slot = h('label', { class: 'ed-slot at-slot' }, input, main, sub);
  const info = h('div', { class: 'at-info' });
  const box = h('div', { class: 'box at-box', dataset: { f: '' } },
    h('div', { class: 'ed-sect' }, h('span', { class: 'ed-sect-title' }, t('attach.title', null, '添付ファイル'), count), note),
    list,
    h('div', { class: 'ed-sect-foot' }, slot, err, info),
    sr.el);

  const kept = () => stored.filter((s) => !s.removed);
  const used = () => kept().length + queue.length;
  const full = () => used() >= perItem;
  const freeBytes = () => {
    const u = usage();
    const freed = stored.filter((s) => s.removed).reduce((n, s) => n + (Number(s.a.size) || 0), 0);
    const queued = queue.reduce((n, q) => n + q.file.size, 0);
    return Math.max(0, u.limit - u.used + freed - queued);
  };

  function paint() {
    const n = used();
    count.textContent = n ? String(n) : '';
    const free = freeBytes();
    note.textContent = free < LOW_SPACE
      ? t('attach.free', { size: formatSize(free) }, '残り {size}')
      : t('attach.limits', { n: limitMb(), max: perItem }, '1 ファイル {n} MB まで · {max} ファイルまで');
    const isFull = full();
    slot.classList.toggle('at-full', isFull);
    slot.classList.toggle('off', busy);
    input.disabled = busy;
    for (const el of [input, slot]) {
      if (isFull) el.setAttribute('aria-disabled', 'true');
      else el.removeAttribute('aria-disabled');
    }
    if (isFull) {
      main.replaceChildren(t('attach.full', { max: perItem }, '{max} ファイルに達しました'));
      sub.textContent = t('attach.fullHint', null, '削除すると追加できます');
      input.setAttribute('aria-label', `${t('attach.full', { max: perItem }, '{max} ファイルに達しました')} ${t('attach.fullHint', null, '削除すると追加できます')}`);
    } else {
      main.replaceChildren(h('span', { class: 'ps', 'aria-hidden': 'true' }, '$ '), t('attach.pick', null, 'ファイルを選ぶ…'));
      sub.textContent = t('attach.multi', null, '複数選べます');
      input.setAttribute('aria-label', t('attach.choose', { n: limitMb(), max: perItem }, '添付ファイルを選ぶ（1 ファイル {n} MB まで、{max} ファイルまで）'));
    }
    list.hidden = !list.children.length;
  }

  const setErr = (...msgs) => { err.replaceChildren(...msgs.filter(Boolean).map((m) => h('div', null, m))); };
  const setInfo = (msg = '') => {
    info.textContent = msg;
    if (msg) sr.say(msg);
  };
  const clearMsgs = () => { setErr(); setInfo(); };

  function storedRow(a) {
    const s = { a, removed: false };
    const shell = editRow({ name: a.name, mime: a.mime });
    s.row = shell.row;
    s.render = () => {
      s.row.classList.toggle('removed', s.removed);
      clear(shell.meta);
      clear(shell.acts);
      if (s.removed) {
        shell.meta.append(h('span', { class: 'at-del' }, t('attach.willRemove', null, '保存すると完全に削除')));
        s.btn = h('button', {
          class: 'btn-mini at-undo', type: 'button', 'aria-label': t('attach.undoName', { name: a.name }, '{name} を残す'),
        }, icon('undo', 12), t('attach.undo', null, '元に戻す'));
        s.btn.addEventListener('click', () => {
          if (full()) {
            setInfo(t('attach.undoFull', { max: perItem }, '{max} ファイルに達しているため戻せません。追加待ちのファイルを外してください'));
            return;
          }
          s.removed = false;
          clearMsgs();
          s.render();
          paint();
          onDirty();
          s.btn.focus();
          sr.say(t('attach.saidKept', { name: a.name }, '{name} を残します'));
        });
      } else {
        shell.meta.append(`${extOf(a.name)} · ${formatSize(a.size)}`);
        s.btn = h('button', {
          class: 'ibtn', type: 'button', title: t('attach.remove', null, '添付ファイルを削除'),
          'aria-label': t('attach.removeName', { name: a.name }, '{name} を削除'),
        }, icon('trash', 13));
        s.btn.addEventListener('click', () => {
          s.removed = true;
          clearMsgs();
          s.render();
          paint();
          onDirty();
          s.btn.focus();
          sr.say(t('attach.saidRemoved', { name: a.name }, '{name} は保存すると完全に削除されます'));
        });
      }
      s.btn.disabled = busy;
      shell.acts.append(s.btn);
    };
    s.render();
    return s;
  }

  function addStored(a) {
    const s = storedRow(a);
    stored.push(s);
    const firstQueued = queue[0]?.row;
    if (firstQueued?.parentNode === list) list.insertBefore(s.row, firstQueued);
    else list.append(s.row);
    return s;
  }

  function queuedRow(file) {
    const q = { file, uid: ++uid, state: 'queued', data: null, message: '' };
    const shell = editRow({ name: file.name, mime: file.type });
    q.row = shell.row;
    q.row.classList.add('queued');
    q.row.dataset.q = String(q.uid);
    q.render = () => {
      q.row.dataset.state = q.state;
      clear(shell.meta);
      clear(shell.acts);
      shell.meta.removeAttribute('title');
      const size = formatSize(file.size);
      q.btn = null;
      if (q.state === 'send') {
        shell.meta.append(tag('[ .. ]', 'run'), ' ', t('attach.saving', null, '保存中'));
        shell.acts.append(h('span', { class: 'spinner at-spin', 'aria-hidden': 'true' }));
        return;
      }
      if (q.state === 'done') {
        shell.meta.append(tag('[ ok ]', 'ok'), ' ', t('attach.added', null, '追加しました'));
        return;
      }
      if (q.state === 'fail') {
        shell.meta.append(tag('[ !! ]', 'err'), ' ', q.message);
        shell.meta.title = q.message;
      } else {
        shell.meta.append(`${extOf(file.name)} · ${size} · `, h('span', { class: 'at-prov' }, t('attach.onSave', null, '保存時に追加')));
      }
      q.btn = h('button', {
        class: 'ibtn', type: 'button', title: t('attach.cancel', null, '追加をやめる'),
        'aria-label': t('attach.cancelName', { name: file.name }, '{name} の追加をやめる'),
      }, icon('x', 11, 3));
      q.btn.disabled = busy;
      q.btn.addEventListener('click', () => dequeue(q));
      shell.acts.append(q.btn);
    };
    q.render();
    return q;
  }

  function dequeue(q) {
    const i = queue.indexOf(q);
    if (i < 0 || busy) return;
    const rows = [...list.children];
    const at = rows.indexOf(q.row);
    queue.splice(i, 1);
    q.row.remove();
    clearMsgs();
    paint();
    onDirty();
    const rest = [...list.children];
    const next = rest[at] || rest[at - 1];
    (next?.querySelector('button:not(:disabled)') || input).focus();
    sr.say(t('attach.saidCancelled', { name: q.file.name }, '{name} の追加をやめました'));
  }

  function addFiles(files) {
    if (busy || !files.length) return;
    const big = [];
    const empty = [];
    const space = [];
    let over = 0;
    const added = [];
    for (const f of files) {
      if (full()) { over++; continue; }
      if (f.size > ATTACHMENT_LIMITS.fileBytes) { big.push(f); continue; }
      if (!f.size) { empty.push(f); continue; }
      if (f.size > freeBytes()) { space.push(f); continue; }
      const q = queuedRow(f);
      queue.push(q);
      list.append(q.row);
      added.push(q);
    }
    const p = (arr) => ({ name: short(arr[0].name), more: arr.length - 1, n: limitMb() });
    const msgs = [];
    let left = '';
    if (big.length === 1) msgs.push(t('attach.tooBig', p(big), '{name} は {n} MB を超えています'));
    else if (big.length) msgs.push(t('attach.tooBigMany', p(big), '{name} ほか {more} ファイルは {n} MB を超えています'));
    if (empty.length === 1) msgs.push(t('attach.empty', p(empty), '{name} は空のファイルです'));
    else if (empty.length) msgs.push(t('attach.emptyMany', p(empty), '{name} ほか {more} ファイルは空のファイルです'));
    if (space.length) msgs.push(t('attach.noSpace', { name: short(space[0].name), size: formatSize(freeBytes()) }, '{name} を入れる保管庫の空きが足りません（残り {size}）'));
    if (over) {
      const o = { ok: added.length, n: over, max: perItem };
      if (added.length && over === 1) left = t('attach.partialOne', o, '{ok} ファイルを追加待ちにしました。残りの 1 ファイルは {max} ファイルの上限を超えるため追加していません');
      else if (added.length) left = t('attach.partial', o, '{ok} ファイルを追加待ちにしました。残りの {n} ファイルは {max} ファイルの上限を超えるため追加していません');
      else if (over === 1) left = t('attach.overOne', o, '1 ファイルは {max} ファイルの上限を超えるため追加していません');
      else left = t('attach.over', o, '{n} ファイルは {max} ファイルの上限を超えるため追加していません');
    }
    setErr(...msgs);
    paint();
    info.textContent = left;
    const said = [];
    if (added.length) {
      onDirty();
      rise(list, added.map((q) => `[data-q="${q.uid}"]`).join(','));
      said.push(added.length === 1
        ? t('attach.saidQueued', { name: added[0].file.name }, '{name} を保存時に追加します')
        : t('attach.saidQueuedMany', { n: added.length }, '{n} ファイルを保存時に追加します'));
    }
    if (left) said.push(left);
    if (said.length) sr.say(said.join(' '));
  }

  for (const a of item?.attachments || []) addStored(a);

  input.addEventListener('click', (e) => {
    if (!full()) return;
    e.preventDefault();
    setInfo(`${t('attach.full', { max: perItem }, '{max} ファイルに達しました')} ${t('attach.fullHint', null, '削除すると追加できます')}`);
  });
  input.addEventListener('change', () => {
    const files = [...(input.files || [])];
    input.value = '';
    addFiles(files);
  });

  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const setOver = (on) => {
    const v = on && !busy;
    slot.classList.toggle('over', v);
    if (v) {
      main.replaceChildren(t('attach.release', null, 'ここで離すと追加'));
      sub.textContent = '';
    } else {
      paint();
    }
  };
  const dragOver = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = busy ? 'none' : 'copy';
    if (!slot.classList.contains('over')) setOver(true);
  };
  box.addEventListener('dragenter', dragOver);
  box.addEventListener('dragover', dragOver);
  box.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget || !box.contains(e.relatedTarget)) setOver(false);
  });
  box.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setOver(false);
    addFiles([...(e.dataTransfer.files || [])]);
  });

  function lock(on) {
    busy = on;
    for (const s of stored) s.render();
    for (const q of queue) if (q.btn) q.btn.disabled = on;
    box.setAttribute('aria-busy', String(on));
    paint();
  }

  async function readOne(q) {
    if (q.data) return true;
    try {
      q.data = toB64(new Uint8Array(await q.file.arrayBuffer()));
      if (q.state === 'fail') { q.state = 'queued'; q.message = ''; q.render(); }
      return true;
    } catch {
      q.state = 'fail';
      q.message = t('attach.readFail', null, 'ファイルを読めませんでした。選び直してください');
      q.render();
      return false;
    }
  }

  async function prepare() {
    clearMsgs();
    const todo = queue.filter((q) => q.state !== 'done');
    const ok = (await Promise.all(todo.map(readOne))).every(Boolean);
    if (!ok) {
      const bad = todo.filter((q) => !q.data);
      sr.say(bad.length === 1
        ? t('attach.saidReadFailOne', { name: bad[0].file.name }, '{name} を読めませんでした')
        : t('attach.saidReadFail', { n: bad.length }, '{n} ファイルを読めませんでした'));
    }
    return ok;
  }

  function settle(finalItem) {
    for (const s of stored.filter((x) => x.removed)) {
      s.row.remove();
      stored.splice(stored.indexOf(s), 1);
    }
    for (const q of queue.filter((x) => x.state === 'done')) {
      q.row.remove();
      queue.splice(queue.indexOf(q), 1);
    }
    if (finalItem && Array.isArray(finalItem.attachments)) {
      const have = new Set(stored.map((s) => s.a.id));
      for (const a of finalItem.attachments) if (!have.has(a.id)) addStored(a);
    }
  }

  async function upload(itemId, { onProgress } = {}) {
    const todo = queue.filter((q) => q.state !== 'done');
    if (!todo.length) return { item: null, failed: [] };
    await Promise.all(todo.map(readOne));
    lock(true);
    const failed = [];
    let last = null;
    let done = 0;
    const total = todo.length;
    for (const q of todo) { if (q.data) { q.state = 'send'; q.render(); } }
    sr.say(total === 1
      ? t('attach.saidSavingOne', { name: todo[0].file.name }, '{name} を保存しています')
      : t('attach.saidSaving', { n: total }, '{n} ファイルを保存しています'));
    await Promise.all(todo.map(async (q) => {
      try {
        if (!q.data) throw new Error('unreadable');
        const res = await call(MSG.VAULT_ADD_ATTACHMENT, {
          itemId, name: storeName(q.file.name), mime: q.file.type || 'application/octet-stream', data: q.data,
        });
        const it = res?.item;
        if (it && (!last || (it.attachments?.length || 0) >= (last.attachments?.length || 0))) last = it;
        q.state = 'done';
        q.data = null;
      } catch (e) {
        q.state = 'fail';
        q.message = q.data ? errText(e) : t('attach.readFail', null, 'ファイルを読めませんでした。選び直してください');
        failed.push({ name: q.file.name, message: q.message });
      }
      q.render();
      done++;
      try { onProgress?.(done, total); } catch {}
    }));
    const ok = total - failed.length;
    busy = false;
    settle(last);
    lock(false);
    if (failed.length) {
      info.textContent = t('attach.retryHint', null, '追加できなかったファイルは、保存でやり直すか × で外せます');
    }
    const parts = [];
    if (ok === 1) parts.push(t('attach.saidAddedOne', null, '1 ファイルを追加しました'));
    else if (ok) parts.push(t('attach.saidAdded', { n: ok }, '{n} ファイルを追加しました'));
    if (failed.length === 1) parts.push(t('attach.saidFailOne', { name: failed[0].name }, '{name} を追加できませんでした'));
    else if (failed.length) parts.push(t('attach.saidFail', { n: failed.length }, '{n} ファイルを追加できませんでした'));
    if (failed.length) parts.push(t('attach.retryHint', null, '追加できなかったファイルは、保存でやり直すか × で外せます'));
    sr.say(parts.join(' '));
    return { item: last, failed };
  }

  paint();
  return {
    el: box,
    kept: () => kept().map((s) => ({ id: s.a.id })),
    pendingCount: () => queue.filter((q) => q.state !== 'done').length,
    changes: () => ({
      queued: queue.filter((q) => q.state !== 'done' && q.state !== 'fail').length,
      failed: queue.filter((q) => q.state === 'fail').length,
      removed: stored.filter((x) => x.removed).length,
    }),
    prepare,
    upload,
    stop() { sr.stop(); },
  };
}

export function attachmentsDetail(it, { onStop } = {}) {
  const items = Array.isArray(it?.attachments) ? it.attachments : [];
  if (!items.length) return [];
  const title = t('attach.title', null, '添付ファイル');
  const urls = new Set();
  const release = (url) => { if (url && urls.delete(url)) URL.revokeObjectURL(url); };
  onStop?.(() => { for (const u of [...urls]) release(u); });
  const box = h('div', { class: 'box at-dbox', role: 'list', 'aria-label': title });
  for (const a of items) box.append(detailRow(it.id, a, release, urls));
  const sect = h('div', { class: 'sect', dataset: { f: '' } },
    h('span', null, title), h('span', { class: 'sect-line' }), h('span', { class: 'at-n' }, String(items.length)));
  return [sect, h('div', { dataset: { f: '' } }, box)];
}

function busyOn(btn, on) {
  btn.classList.toggle('busy', on);
  btn.disabled = on;
  btn.setAttribute('aria-busy', String(on));
}

function detailRow(itemId, a, release, urls) {
  const name = safeFileName(a.name, 'attachment');
  const actions = h('span', { class: 'pk-actions' });
  const row = h('div', { class: 'pk at-pk' },
    h('span', { class: 'pk-ico', 'aria-hidden': 'true' }, fileIcon(name, a.mime)),
    h('span', { class: 'pk-text' },
      h('span', { class: 'pk-user', title: name }, name),
      h('span', { class: 'pk-meta at-dmeta' },
        t('attach.meta', { ext: extOf(name), size: formatSize(a.size), date: formatDate(a.addedAt) }, '{ext} · {size} · 追加 {date}'))),
    actions);
  const item = h('div', { class: 'at-ditem', role: 'listitem' }, row);
  const fetchBytes = () => call(MSG.VAULT_GET_ATTACHMENT, { itemId, attachmentId: a.id });

  const dl = h('button', {
    class: 'ibtn at-btn', type: 'button', title: t('attach.download', null, 'ダウンロード'),
    'aria-label': t('attach.downloadName', { name }, '{name} をダウンロード'),
  }, icon('download', 13), h('span', { class: 'spinner', 'aria-hidden': 'true' }));
  dl.addEventListener('click', async () => {
    const token = liveToken();
    busyOn(dl, true);
    try {
      const res = await fetchBytes();
      if (!live(token) || !dl.isConnected) return;
      downloadFile(fromB64(res.data), name, 'application/octet-stream');
      toast(t('attach.downloaded', null, 'ダウンロードしました'), name);
    } catch (e) {
      if (!live(token) || !dl.isConnected) return;
      toastError(t('attach.downloadFail', null, 'ダウンロードできませんでした'), errText(e));
    } finally {
      if (dl.isConnected) busyOn(dl, false);
    }
  });

  const mime = String(a.mime || '').toLowerCase();
  if (PREVIEW_TYPES.has(mime)) {
    let url = '';
    let pane = null;
    const pv = h('button', {
      class: 'ibtn at-btn', type: 'button', title: t('attach.preview', null, 'プレビュー'),
      'aria-label': t('attach.previewName', { name }, '{name} をプレビュー'), 'aria-expanded': 'false',
    }, icon('image', 13), h('span', { class: 'spinner', 'aria-hidden': 'true' }));
    const hide = () => {
      pane?.remove();
      pane = null;
      release(url);
      url = '';
      pv.setAttribute('aria-expanded', 'false');
      pv.classList.remove('on');
    };
    pv.addEventListener('click', async () => {
      if (pane) { hide(); return; }
      const token = liveToken();
      busyOn(pv, true);
      try {
        const res = await fetchBytes();
        if (!live(token) || !pv.isConnected) return;
        url = URL.createObjectURL(new Blob([fromB64(res.data)], { type: mime }));
        urls.add(url);
        const img = h('img', { class: 'at-img', alt: name, src: url, draggable: 'false' });
        pane = h('div', { class: 'at-prev' }, img);
        img.addEventListener('error', () => {
          pane?.replaceChildren(h('span', { class: 'at-prev-err' }, t('attach.previewFail', null, 'この画像は表示できません')));
        });
        item.append(pane);
        pv.setAttribute('aria-expanded', 'true');
        pv.classList.add('on');
      } catch (e) {
        if (!live(token) || !pv.isConnected) return;
        toastError(t('attach.previewFail', null, 'この画像は表示できません'), errText(e));
      } finally {
        if (pv.isConnected) busyOn(pv, false);
      }
    });
    actions.append(pv);
  }
  actions.append(dl);
  return item;
}
