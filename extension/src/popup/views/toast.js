// The light toast with a shrinking progress bar, and an optional action (元に戻す).
// How long it stays depends on what it carries: a one-line note is gone quickly, a note with a
// second line (「30 秒後にクリップボードから消去します」) gets time to be read, errors and toasts with
// an action longer still. Hovering it or focusing its button holds it until the pointer or focus
// leaves; Ctrl+Z (⌘Z) runs the action while the toast is up (controllers/keyboard.js).

const DURATION = { short: 3000, sub: 5000, err: 7000, action: 8000 };
let hideTimer = 0;
let barAnim = null;
let left = 0; // ms still to show
let startedAt = 0;
let hovered = false; // the pointer moved onto the toast
let focused = false; // focus is inside it (its button)
let paused = false;
let action = null; // { label, run } while the toast offers one

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

/** Pause while hovered or focused, run again when neither is true. */
function sync() {
  if (!$('toast')?.classList.contains('on')) return;
  const hold = hovered || focused;
  if (hold && !paused) {
    clearTimeout(hideTimer);
    paused = true;
    left = Math.max(800, left - (performance.now() - startedAt));
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
  // the action button had focus: give it to the list rather than to <body>
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

/**
 * toast('パスワードをコピーしました', '30秒後に…') — sub is optional; kind 'err' shows the red variant.
 * `action: { label, run, title? }` adds a button (run once, then the toast goes).
 */
export function toast(msg, sub = null, kind = 'ok', { action: act = null } = {}) {
  const el = $('toast');
  if (!el) return;
  // the old toast's button had focus and this toast has none: give focus to the list first
  if (!act && el.contains(document.activeElement)) $('list')?.focus({ preventScroll: true });
  $('toastMsg').textContent = msg;
  $('toastSub').textContent = sub || '';
  el.classList.toggle('err', kind === 'err');
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  setAction(act);
  el.classList.add('on');
  // a pointer that was already resting where the toast appears does not hold it; moving onto it does
  focused = el.contains(document.activeElement);
  left = durationOf(sub, kind, act);
  barAnim?.cancel();
  barAnim = $('toastBar').animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }],
    { duration: left, easing: 'linear', fill: 'forwards' });
  run();
  sync();
}

export const toastError = (msg, sub) => toast(msg, sub, 'err');

/** Runs the toast's action, if one is showing (the button, or Ctrl+Z). Returns whether it ran. */
export function runToastAction() {
  if (!action || !$('toast')?.classList.contains('on')) return false;
  const { run: fn } = action;
  clearTimeout(hideTimer);
  hide();
  fn();
  return true;
}

export const toastHasAction = () => !!action && !!$('toast')?.classList.contains('on');

/** Hide immediately and drop the text (it can contain item titles). */
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

/** Hover and focus hold the toast; its button runs the action. Called once at start-up. */
export function initToast() {
  const el = $('toast');
  if (!el) return;
  el.addEventListener('mouseenter', () => { hovered = true; sync(); });
  el.addEventListener('mouseleave', () => { hovered = false; sync(); });
  el.addEventListener('focusin', () => { focused = true; sync(); });
  el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget)) { focused = false; sync(); } });
  $('toastAct')?.addEventListener('click', runToastAction);
}
