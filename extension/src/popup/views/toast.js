// The dark toast pill with a 2.6 s progress bar.

const DURATION = 2600;
let hideTimer = 0;
let barAnim = null;

/** toast('パスワードをコピーしました', '30秒後に…') — sub is optional; kind 'err' shows the red variant. */
export function toast(msg, sub = null, kind = 'ok') {
  const el = document.getElementById('toast');
  if (!el) return;
  document.getElementById('toastMsg').textContent = msg;
  document.getElementById('toastSub').textContent = sub || '';
  el.classList.toggle('err', kind === 'err');
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.classList.add('on');
  barAnim?.cancel();
  const bar = document.getElementById('toastBar');
  barAnim = bar.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }],
    { duration: DURATION, easing: 'linear', fill: 'forwards' });
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => el.classList.remove('on'), DURATION);
}

export const toastError = (msg, sub) => toast(msg, sub, 'err');

/** Hide immediately and drop the text (it can contain item titles). */
export function hideToast() {
  clearTimeout(hideTimer);
  barAnim?.cancel();
  barAnim = null;
  document.getElementById('toast')?.classList.remove('on', 'err');
  for (const id of ['toastMsg', 'toastSub']) {
    const el = document.getElementById(id);
    if (el) el.textContent = '';
  }
}
