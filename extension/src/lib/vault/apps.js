import { invalid, isObject } from './common.js';

// Desktop apps a login is linked to (Akari Desktop fills them). Not secret.
export const APP_LIMITS = Object.freeze({ count: 20, exe: 255, signer: 256, title: 200 });

const EXE_FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f\u007f]/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function optionalText(v, max, name) {
  if (v == null) return null;
  if (typeof v !== 'string') throw invalid('Invalid app ' + name);
  const s = v.trim();
  if (!s) return null;
  if (s.length > max || CONTROL.test(s)) throw invalid('Invalid app ' + name);
  return s;
}

/** One link: { exe, signer, title }. exe is a file name only, kept in lower case. Throws INVALID. */
export function cleanApp(app) {
  if (!isObject(app) || typeof app.exe !== 'string') throw invalid('Invalid app');
  const exe = app.exe.toLowerCase();
  if (!exe || exe.length > APP_LIMITS.exe || exe !== exe.trim() || exe.endsWith('.') || EXE_FORBIDDEN.test(exe)) {
    throw invalid('Invalid app exe');
  }
  return {
    exe,
    signer: optionalText(app.signer, APP_LIMITS.signer, 'signer'),
    title: optionalText(app.title, APP_LIMITS.title, 'title'),
  };
}

export const sameApp = (a, b) => a.exe === b.exe && (a.signer ?? null) === (b.signer ?? null);

/** Saving: every rule must hold, or INVALID. */
export function checkApps(list) {
  if (!Array.isArray(list) || list.length > APP_LIMITS.count) throw invalid('Invalid apps');
  const out = [];
  for (const raw of list) {
    const app = cleanApp(raw);
    if (out.some((a) => sameApp(a, app))) throw invalid('Duplicate app');
    out.push(app);
  }
  return out;
}

/** Importing: drop what breaks a rule, keep the first of duplicates, cap the count. */
export function normalizeApps(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (out.length >= APP_LIMITS.count) break;
    let app;
    try {
      app = cleanApp(raw);
    } catch {
      continue;
    }
    if (!out.some((a) => sameApp(a, app))) out.push(app);
  }
  return out;
}

/** Merging two copies of a login: everything from both, ours first. */
export function unionApps(mine, theirs) {
  return normalizeApps([...(Array.isArray(mine) ? mine : []), ...(Array.isArray(theirs) ? theirs : [])]);
}

export const hasApps = (item) => isObject(item) && Array.isArray(item.apps) && item.apps.length > 0;
