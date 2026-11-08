// The search box's language: free text, plus operators that narrow the list.
//
//   type:login   type:カード      the item type, by id (or its start) or by a part of its name
//   has:totp  has:passkey  has:2fa  has:url
//   is:weak  is:reused  is:old  is:no2fa  is:fav
//   vault:仕事                     the vault, by (the start of) its name
//   -has:totp                      any operator can be negated with a leading -
//
// A word that only looks like an operator (https://…, an unknown key, `type:` still being typed)
// is searched as text. Text matches the title and the item's non-secret text as one substring;
// when nothing matches that way, the title is matched loosely (the letters in order: "amzn" finds
// "Amazon") so a typo does not leave the list empty. Pure: no DOM, no state.

import { TYPE_IDS, typeLabel } from '../shared/item-types.js';
import { normQuery } from './views/format.js';

export const OPERATORS = Object.freeze({
  type: null, // any type id or name
  has: Object.freeze(['totp', 'passkey', '2fa', 'url']),
  is: Object.freeze(['weak', 'reused', 'old', 'no2fa', 'fav']),
  vault: null, // any vault name
});

const LOOSE_MIN = 2; // shorter text never matches loosely

/**
 * Splits a query into its operators and its free text.
 * @returns {{ text: string, ops: { key: string, value: string, neg: boolean }[] }} text is normalised (normQuery)
 */
export function parseQuery(raw) {
  const words = normQuery(raw).split(/\s+/).filter(Boolean);
  const ops = [];
  const text = [];
  for (const w of words) {
    const m = /^(-?)([a-z]+):(.+)$/.exec(w);
    if (m && Object.hasOwn(OPERATORS, m[2]) && isKnownValue(m[2], m[3])) ops.push({ key: m[2], value: m[3], neg: m[1] === '-' });
    else if (/^-?[a-z]+:$/.test(w) && Object.hasOwn(OPERATORS, w.replace(/^-|:$/g, ''))) continue; // `type:` being typed
    else text.push(w);
  }
  return { text: text.join(' '), ops };
}

function isKnownValue(key, value) {
  const list = OPERATORS[key];
  return !list || list.includes(value);
}

/** The letters of `needle` appear in `hay` in order (both normalised). */
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

/** Type ids an operator value stands for: the id itself, else every type whose id starts with it or whose name contains it. */
function typesFor(value) {
  const exact = TYPE_IDS.filter((id) => id.toLowerCase() === value);
  if (exact.length) return new Set(exact);
  return new Set(TYPE_IDS.filter((id) => startsOrIs(id, value) || normQuery(typeLabel(id)).includes(value)));
}

/**
 * A matcher for the query. `ctx` gives what the matcher cannot know itself:
 *   issuesOf(item) → the item's password issues (lib/health.js), vaultName(id) → its vault's name,
 *   textOf(item) → { title, rest } normalised strings to search.
 * @returns {{ text: string, ops: object[], empty: boolean, test(item): boolean, loose(item): boolean }}
 */
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
