// Per-host differences the UI cannot hide behind chrome.* shims.
// The desktop shell sets globalThis.__akariPlatform before any module runs; it is read once, here.
// Not for background/: it touches document and navigator.clipboard.

const DOWNLOAD_URL_LIFETIME_MS = 4000;
const revokeTimers = new Map();

function revoke(url) {
  clearTimeout(revokeTimers.get(url));
  revokeTimers.delete(url);
  URL.revokeObjectURL(url);
}

export function revokeDownloads() {
  for (const url of [...revokeTimers.keys()]) revoke(url);
}

const extension = {
  kind: 'extension',
  can: Object.freeze({ autofill: true, passkeyPage: true, appFill: false, captureQr: true, startFromBackup: false }),
  async saveFile(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    revokeTimers.set(url, setTimeout(() => revoke(url), DOWNLOAD_URL_LIFETIME_MS));
    return true;
  },
  async copy(value) {
    await navigator.clipboard.writeText(value);
  },
  captureQr: () => chrome.tabs.captureVisibleTab(undefined, { format: 'png' }),
  startFromBackup: undefined,
  settingsPage: null,
  lockNote: () => null,
};

const METHODS = ['saveFile', 'copy', 'captureQr', 'startFromBackup'];

// name and desc are read each time they are shown, so the host can follow the UI language.
function settingsPageOf(page) {
  if (!page || typeof page !== 'object' || typeof page.open !== 'function') return null;
  const text = (key) => {
    try {
      const v = page[key];
      return typeof v === 'string' ? v : '';
    } catch {
      return '';
    }
  };
  return Object.freeze({
    get name() { return text('name'); },
    get desc() { return text('desc'); },
    open: (container) => page.open(container),
  });
}

function lockNoteOf(injected) {
  const fn = injected.lockNote;
  if (typeof fn !== 'function') return extension.lockNote;
  return () => {
    try {
      const v = fn.call(injected);
      return typeof v === 'string' && v.trim() ? v : null;
    } catch {
      return null;
    }
  };
}

function build(injected) {
  if (!injected || typeof injected !== 'object' || injected.kind !== 'desktop') return extension;
  const out = { kind: 'desktop', can: { ...extension.can } };
  const can = injected.can && typeof injected.can === 'object' ? injected.can : {};
  for (const k of Object.keys(extension.can)) if (typeof can[k] === 'boolean') out.can[k] = can[k];
  for (const k of METHODS) {
    const fn = injected[k];
    out[k] = typeof fn === 'function' ? (...args) => fn.apply(injected, args) : extension[k];
  }
  out.settingsPage = settingsPageOf(injected.settingsPage);
  out.lockNote = lockNoteOf(injected);
  Object.freeze(out.can);
  return out;
}

export const platform = Object.freeze(build(globalThis.__akariPlatform));
