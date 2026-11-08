import { TYPE_IDS, typeLabel } from '../shared/item-types.js';
import { normQuery } from './views/format.js';

export const OPERATORS = Object.freeze({
  type: null,
  has: Object.freeze(['totp', 'passkey', '2fa', 'url']),
  is: Object.freeze(['weak', 'reused', 'old', 'no2fa', 'fav']),
  vault: null,
});

const LOOSE_MIN = 2;

export function parseQuery(raw) {
  const words = normQuery(raw).split(/\s+/).filter(Boolean);
  const ops = [];
  const text = [];
  for (const w of words) {
    const m = /^(-?)([a-z]+):(.+)$/.exec(w);
    if (m && Object.hasOwn(OPERATORS, m[2]) && isKnownValue(m[2], m[3])) ops.push({ key: m[2], value: m[3], neg: m[1] === '-' });
    else if (/^-?[a-z]+:$/.test(w) && Object.hasOwn(OPERATORS, w.replace(/^-|:$/g, ''))) continue;
    else text.push(w);
  }
  return { text: text.join(' '), ops };
}

function isKnownValue(key, value) {
  const list = OPERATORS[key];
  return !list || list.includes(value);
}

export function looseMatch(hay, needle) {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

const startsOrIs = (name, value) => {
  const n = normQuery(name);
  return n === value || n.startsWith(value);
};

function typesFor(value) {
  const exact = TYPE_IDS.filter((id) => id.toLowerCase() === value);
  if (exact.length) return new Set(exact);
  return new Set(TYPE_IDS.filter((id) => startsOrIs(id, value) || normQuery(typeLabel(id)).includes(value)));
}

export function compileQuery(raw, ctx) {
  const { text, ops } = parseQuery(raw);
  const checks = ops.map((op) => {
    let fn;
    switch (op.key) {
      case 'type': {
        const types = typesFor(op.value);
        fn = (it) => types.has(it.type);
        break;
      }
      case 'has':
        fn = {
          totp: (it) => !!it.totp?.secret,
          passkey: (it) => !!it.passkeys?.length,
          '2fa': (it) => !!it.totp?.secret || !!it.passkeys?.length,
          url: (it) => !!it.url,
        }[op.value];
        break;
      case 'is':
        fn = op.value === 'fav' ? (it) => !!it.fav : (it) => ctx.issuesOf(it).includes(op.value);
        break;
      case 'vault':
        fn = (it) => it.vault === op.value || startsOrIs(ctx.vaultName(it.vault) || '', op.value);
        break;
      default:
        fn = () => true;
    }
    return op.neg ? (it) => !fn(it) : fn;
  });
  const passes = (it) => checks.every((fn) => fn(it));
  return {
    text,
    ops,
    empty: !text && !ops.length,
    test(it) {
      if (!passes(it)) return false;
      if (!text) return true;
      const { title, rest } = ctx.textOf(it);
      return title.includes(text) || rest.includes(text);
    },
    loose(it) {
      if (text.length < LOOSE_MIN || !passes(it)) return false;
      return looseMatch(ctx.textOf(it).title.replace(/\s+/g, ''), text.replace(/\s+/g, ''));
    },
  };
}
