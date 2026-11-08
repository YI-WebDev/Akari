const DURATION = { short: 3000, sub: 5000, err: 7000, action: 8000 };
let hideTimer = 0;
let barAnim = null;
let left = 0;
let startedAt = 0;
let hovered = false;
let focused = false;
let paused = false;
let action = null;
const MIN_REMAINING_AFTER_HOLD_MS = 800;

const $ = (id) => document.getElementById(id);

function durationOf(sub, kind, act) {
  if (act) return DURATION.action;
  if (kind === 'err') return DURATION.err;
  return sub ? DURATION.sub : DURATION.short;
}

function run() {
  clearTimeout(hideTimer);
  paused = false;
  startedAt = performance.now();
  barAnim?.play();
  hideTimer = setTimeout(hide, left);
}

function sync() {
  if (!$('toast')?.classList.contains('on')) return;
  const hold = hovered || focused;
  if (hold && !paused) {
    clearTimeout(hideTimer);
    paused = true;
    left = Math.max(MIN_REMAINING_AFTER_HOLD_MS, left - (performance.now() - startedAt));
    barAnim?.pause();
  } else if (!hold && paused) {
    run();
  }
}

function hide() {
  const el = $('toast');
  if (!el) return;
  const hadFocus = el.contains(document.activeElement);
  el.classList.remove('on');
  setAction(null);
  hovered = false;
  focused = false;
  paused = false;
  if (hadFocus) $('list')?.focus({ preventScroll: true });
}

function setAction(act) {
  action = act;
  const btn = $('toastAct');
  if (!btn) return;
  btn.hidden = !act;
  btn.textContent = act ? act.label : '';
  if (act?.title) btn.title = act.title;
  else btn.removeAttribute('title');
}

export function toast(msg, sub = null, kind = 'ok', { action: act = null } = {}) {
  const el = $('toast');
  if (!el) return;
  if (!act && el.contains(document.activeElement)) $('list')?.focus({ preventScroll: true });
  $('toastMsg').textContent = msg;
  $('toastSub').textContent = sub || '';
  el.classList.toggle('err', kind === 'err');
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  setAction(act);
  el.classList.add('on');
  focused = el.contains(document.activeElement);
  left = durationOf(sub, kind, act);
  barAnim?.cancel();
  barAnim = $('toastBar').animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }],
    { duration: left, easing: 'linear', fill: 'forwards' });
  run();
  sync();
}

export const toastError = (msg, sub) => toast(msg, sub, 'err');

export function runToastAction() {
  if (!action || !$('toast')?.classList.contains('on')) return false;
  const { run: fn } = action;
  clearTimeout(hideTimer);
  hide();
  fn();
  return true;
}

export const toastHasAction = () => !!action && !!$('toast')?.classList.contains('on');

export function hideToast() {
  clearTimeout(hideTimer);
  barAnim?.cancel();
  barAnim = null;
  hovered = false;
  focused = false;
  paused = false;
  setAction(null);
  $('toast')?.classList.remove('on', 'err');
  for (const id of ['toastMsg', 'toastSub']) {
    const el = $(id);
    if (el) el.textContent = '';
  }
}

export function initToast() {
  const el = $('toast');
  if (!el) return;
  el.addEventListener('mouseenter', () => { hovered = true; sync(); });
  el.addEventListener('mouseleave', () => { hovered = false; sync(); });
  el.addEventListener('focusin', () => { focused = true; sync(); });
  el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget)) { focused = false; sync(); } });
  $('toastAct')?.addEventListener('click', runToastAction);
}
