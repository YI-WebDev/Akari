// Host/domain rules used for autofill matching and WebAuthn rpId checks, based on
// the full Public Suffix List (psl-data.js, regenerate with scripts/build-psl.mjs).
// Hosts under a TLD the list doesn't know get no registrable domain at all, so
// they only ever match themselves exactly.

import PSL from './psl-data.js';

const EXACT = new Set();
const WILDCARD = new Set(); // "*.ck" stored as "ck"
const EXCEPTION = new Set(); // "!www.ck" stored as "www.ck"
for (const rule of PSL.split('\n')) {
  if (rule.startsWith('!')) EXCEPTION.add(rule.slice(1));
  else if (rule.startsWith('*.')) WILDCARD.add(rule.slice(2));
  else EXACT.add(rule);
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Number of labels in the public suffix of `labels`, or 0 when no PSL rule matches. */
function suffixLength(labels) {
  for (let i = 0; i < labels.length; i++) {
    const name = labels.slice(i).join('.');
    if (EXCEPTION.has(name)) return labels.length - i - 1;
    if (EXACT.has(name)) return labels.length - i;
    if (i + 1 < labels.length && WILDCARD.has(labels.slice(i + 1).join('.'))) return labels.length - i;
  }
  return 0;
}

/** Lower-cased hostname of a URL, or '' if it cannot be parsed. Accepts bare hosts ("github.com"). */
export function hostnameOf(url) {
  if (!url) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : 'https://' + url);
    return u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

export const isIpAddress = (host) => IPV4.test(host) || host.includes(':') || host.startsWith('[');

/** True for a public suffix ("com", "co.jp", "github.io") and for any single label except localhost. */
export function isPublicSuffix(domain) {
  const d = domain.toLowerCase().replace(/\.$/, '');
  if (d === 'localhost') return false;
  const labels = d.split('.');
  return labels.length === 1 || suffixLength(labels) === labels.length;
}

/**
 * eTLD+1 ("accounts.google.com" → "google.com", "www.amazon.co.jp" → "amazon.co.jp").
 * IPs and localhost are returned as-is. Returns null for a public suffix itself and
 * for hosts under a TLD the PSL doesn't know.
 */
export function registrableDomain(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h) return null;
  if (isIpAddress(h) || h === 'localhost') return h;
  const labels = h.split('.');
  const n = suffixLength(labels);
  if (n === 0 || n >= labels.length) return null;
  return labels.slice(-(n + 1)).join('.');
}

/** True when the saved item URL belongs to the same site (registrable domain) as the tab URL. */
export function sameSite(itemUrl, tabUrl) {
  const a = hostnameOf(itemUrl);
  const b = hostnameOf(tabUrl);
  if (!a || !b) return false;
  if (a === b) return true;
  if (isIpAddress(a) || isIpAddress(b)) return false;
  const ra = registrableDomain(a);
  return !!ra && ra === registrableDomain(b);
}

/** Secure context for WebAuthn: https, or http on localhost/127.0.0.1. */
export function isSecureOrigin(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/**
 * WebAuthn rpId rule: rpId must equal the origin's host or be a parent domain of it
 * on a label boundary, and must not be a public suffix.
 */
export function isValidRpId(rpId, originUrl) {
  const host = hostnameOf(originUrl);
  const rp = String(rpId || '').toLowerCase();
  if (!host || !rp) return false;
  if (rp === host) return !isPublicSuffix(rp);
  if (isIpAddress(host)) return false;
  if (!host.endsWith('.' + rp)) return false;
  // A parent domain must itself be registrable (not a suffix, not under an unknown TLD).
  return registrableDomain(rp) !== null;
}
