import { toB64url, fromB64url } from '../../shared/bytes.js';
import { registrableDomain, isPublicSuffix, isIpAddress } from '../../shared/domain.js';
import { encode as cborEncode } from '../cbor.js';
import { COSE_ALG_ES256 } from '../webauthn.js';
import { isObject, clampTs, lengthIn } from './common.js';

const HOST_LIKE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const optString = (v, max) => v == null || (typeof v === 'string' && v.length <= max);

export function normalizePasskey(pk, nowMs) {
  const ok = isObject(pk)
    && lengthIn(pk.credentialId, 16, 1023)
    && lengthIn(pk.userHandle, 1, 64)
    && lengthIn(pk.privateKey, 32, 2048)
    && lengthIn(pk.publicKey, 32, 1024)
    && pk.alg === COSE_ALG_ES256
    && typeof pk.rpId === 'string' && HOST_LIKE.test(pk.rpId)
    && (pk.signCount == null || (Number.isSafeInteger(pk.signCount) && pk.signCount >= 0))
    && optString(pk.userName, 256) && optString(pk.userDisplayName, 256)
    && Number.isFinite(pk.createdAt) && (pk.lastUsedAt == null || Number.isFinite(pk.lastUsedAt));
  if (!ok) return null;
  return {
    credentialId: pk.credentialId,
    rpId: pk.rpId,
    userHandle: pk.userHandle,
    userName: pk.userName ?? '',
    userDisplayName: pk.userDisplayName ?? '',
    privateKey: pk.privateKey,
    publicKey: pk.publicKey,
    alg: COSE_ALG_ES256,
    signCount: pk.signCount ?? 0,
    createdAt: clampTs(pk.createdAt, nowMs, nowMs),
    lastUsedAt: clampTs(pk.lastUsedAt, null, nowMs),
  };
}

export function normalizePasskeys(list, nowMs) {
  if (!Array.isArray(list)) return [];
  const out = new Map();
  for (const pk of list.map((p) => normalizePasskey(p, nowMs))) {
    if (pk && !out.has(pk.credentialId)) out.set(pk.credentialId, pk);
  }
  return [...out.values()];
}

export async function passkeyFromImport(pk, nowMs = Date.now()) {
  if (!isObject(pk) || !lengthIn(pk.privateKey, 32, 2048) || !importableRpId(pk.rpId)) return null;
  let publicKey;
  try {
    const key = await crypto.subtle.importKey('pkcs8', fromB64url(pk.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const { x, y } = await crypto.subtle.exportKey('jwk', key);
    publicKey = toB64url(cborEncode(new Map([[1, 2], [3, COSE_ALG_ES256], [-1, 1], [-2, fromB64url(x)], [-3, fromB64url(y)]])));
  } catch {
    return null;
  }
  return normalizePasskey({
    credentialId: pk.credentialId,
    rpId: pk.rpId,
    userHandle: pk.userHandle,
    userName: pk.userName ?? '',
    userDisplayName: pk.userDisplayName ?? '',
    privateKey: pk.privateKey,
    publicKey,
    alg: COSE_ALG_ES256,
    signCount: 0,
    createdAt: Number.isFinite(pk.createdAt) ? pk.createdAt : nowMs,
    lastUsedAt: null,
  }, nowMs);
}

function importableRpId(rpId) {
  if (typeof rpId !== 'string' || !HOST_LIKE.test(rpId)) return false;
  if (rpId === 'localhost') return true;
  return !isIpAddress(rpId) && registrableDomain(rpId) !== null && !isPublicSuffix(rpId);
}
