export const JA = /[\u{3000}-\u{30ff}\u{3400}-\u{4dbf}\u{4e00}-\u{9fff}\u{f900}-\u{faff}\u{ff01}-\u{ff60}\u{ffe0}-\u{ffee}]/u;

export const DOTTED = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+$/;

const BEFORE_EXPR = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await']);
const NOT_CALLEE = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'void',
  'delete', 'in', 'of', 'instanceof', 'new', 'throw', 'case', 'do', 'else', 'yield', 'await', 'with']);

const ID_START = /[\p{ID_Start}_$]/u;
const ID_PART = /[\p{ID_Continue}$\u{200c}\u{200d}]/u;
const NUMBER = /^(?:0[xXoObB][\da-fA-F_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?n?)/;
const PUNCT3 = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??='];
const PUNCT2 = ['=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=',
  '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**'];
const BOM = String.fromCharCode(0xfeff);

export function tokenize(src) {
  const out = [];
  const comments = [];
  const n = src.length;
  const tplDepth = [];
  let i = 0;
  let line = 1;
  let start = 0;
  let prev = null;
  const push = (tok) => { tok.pos = start; tok.endLine = line; out.push(tok); prev = tok; };

  const regexAllowed = () => {
    if (!prev) return true;
    switch (prev.type) {
      case 'num': case 'str': case 'regex': return false;
      case 'tpl': return prev.kind === 'head' || prev.kind === 'middle';
      case 'name': return BEFORE_EXPR.has(prev.value);
      default: return ![')', ']', '}', '++', '--'].includes(prev.value);
    }
  };

  const escape = (at) => {
    const c = src[at + 1];
    const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' };
    if (Object.hasOwn(simple, c)) return [simple[c], 2];
    if (c === '0' && !/\d/.test(src[at + 2] || '')) return ['\0', 2];
    if (c === 'x') return [String.fromCharCode(parseInt(src.slice(at + 2, at + 4), 16)), 4];
    if (c === 'u' && src[at + 2] === '{') {
      const end = src.indexOf('}', at);
      return [String.fromCodePoint(parseInt(src.slice(at + 3, end), 16)), end - at + 1];
    }
    if (c === 'u') return [String.fromCharCode(parseInt(src.slice(at + 2, at + 6), 16)), 6];
    if (c === '\r') { line++; return ['', src[at + 2] === '\n' ? 3 : 2]; }
    if (c === '\n') { line++; return ['', 2]; }
    return [c, 2];
  };

  const template = (first) => {
    const from = line;
    let cooked = '';
    while (i < n) {
      const c = src[i];
      if (c === '`') {
        i++;
        return push({ type: 'tpl', kind: first ? 'full' : 'tail', value: cooked, line: from });
      }
      if (c === '$' && src[i + 1] === '{') {
        i += 2;
        tplDepth.push(0);
        return push({ type: 'tpl', kind: first ? 'head' : 'middle', value: cooked, line: from });
      }
      if (c === '\\') {
        const [s, len] = escape(i);
        cooked += s;
        i += len;
        continue;
      }
      if (c === '\r') { i++; continue; }
      if (c === '\n') line++;
      cooked += c;
      i++;
    }
    throw new Error(`unterminated template literal from line ${from}`);
  };

  while (i < n) {
    const c = src[i];
    start = i;
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c) || c === BOM) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      comments.push({ value: src.slice(start, i), line, endLine: line });
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error(`unterminated comment on line ${line}`);
      const from = line;
      for (let k = i; k < end; k++) if (src[k] === '\n') line++;
      i = end + 2;
      comments.push({ value: src.slice(start, i), line: from, endLine: line });
      continue;
    }
    if (c === '\'' || c === '"') {
      const from = line;
      let cooked = '';
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\n') throw new Error(`unterminated string on line ${from}`);
        if (src[i] === '\\') {
          const [s, len] = escape(i);
          cooked += s;
          i += len;
        } else {
          cooked += src[i++];
        }
      }
      i++;
      push({ type: 'str', value: cooked, line: from });
      continue;
    }
    if (c === '`') { i++; template(true); continue; }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID_PART.test(src[j])) j++;
      push({ type: 'name', value: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1] || ''))) {
      const m = NUMBER.exec(src.slice(i, i + 64));
      push({ type: 'num', value: m[0], line });
      i += m[0].length;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      for (; j < n; j++) {
        const d = src[j];
        if (d === '\\') { j++; continue; }
        if (d === '\n') throw new Error(`unterminated regex on line ${line}`);
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
      }
      j++;
      while (j < n && /[a-z]/i.test(src[j])) j++;
      push({ type: 'regex', value: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (c === '}' && tplDepth.length) {
      if (tplDepth[tplDepth.length - 1] === 0) {
        tplDepth.pop();
        i++;
        template(false);
        continue;
      }
      tplDepth[tplDepth.length - 1]--;
    }
    if (c === '{' && tplDepth.length) tplDepth[tplDepth.length - 1]++;
    const p = PUNCT3.find((s) => src.startsWith(s, i)) || PUNCT2.find((s) => src.startsWith(s, i)) || c;
    push({ type: 'punct', value: p, line });
    i += p.length;
  }
  out.comments = comments;
  return out;
}

export function scan(src) {
  const tokens = tokenize(src);
  const literals = [];
  const frames = [];
  const decls = [];

  const callFrame = () => {
    for (let k = frames.length - 1; k >= 0; k--) {
      if (frames[k].call) return frames[k];
      if (frames[k].block) return null;
    }
    return null;
  };

  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    const before = tokens[k - 1];
    const depth = frames.length;
    const top = frames[depth - 1];

    if (tok.type === 'name' && ['const', 'let', 'var'].includes(tok.value)
      && tokens[k + 1]?.type === 'name' && tokens[k + 2]?.value === '=') {
      decls.push({ name: tokens[k + 1].value, depth });
    }

    if (tok.type === 'str' || tok.type === 'tpl') {
      const cf = callFrame();
      const next = tokens[k + 1];
      const whole = !!cf && (tok.type === 'str' || tok.kind === 'full') && top === cf
        && [',', '('].includes(before?.value) && [',', ')'].includes(next?.value);
      literals.push({
        value: tok.value, line: tok.line, endLine: tok.endLine, kind: tok.type === 'str' ? 'str' : tok.kind,
        call: cf ? { id: cf.call.id, name: cf.call.name, arg: cf.arg, line: cf.call.line } : null,
        decl: decls.length ? decls[decls.length - 1].name : null,
        whole,
      });
    }

    if (tok.type === 'tpl' && (tok.kind === 'head' || tok.kind === 'middle')) {
      if (tok.kind === 'middle') frames.pop();
      frames.push({ open: '${', call: null, arg: 0 });
      continue;
    }
    if (tok.type === 'tpl' && tok.kind === 'tail') {
      frames.pop();
      continue;
    }
    if (tok.type !== 'punct') continue;

    if (tok.value === '(') {
      const named = before?.type === 'name' && !NOT_CALLEE.has(before.value) && tokens[k - 2]?.value !== 'function';
      const ofExpr = before?.type === 'punct' && (before.value === ')' || before.value === ']');
      const member = tokens[k - 2]?.value === '.' || tokens[k - 2]?.value === '?.';
      const call = named || ofExpr ? { id: k, name: named && !member ? before.value : null, line: tok.line } : null;
      frames.push({ open: '(', call, arg: 0 });
    } else if (tok.value === '[') {
      frames.push({ open: '[', call: null, arg: 0 });
    } else if (tok.value === '{') {
      const block = before?.value === ')' || before?.value === '=>' || before?.value === 'else';
      frames.push({ open: '{', call: null, arg: 0, block });
    } else if (tok.value === ')' || tok.value === ']' || tok.value === '}') {
      frames.pop();
      while (decls.length && decls[decls.length - 1].depth > frames.length) decls.pop();
    } else if (tok.value === ',') {
      if (top?.call) top.arg++;
      while (decls.length && decls[decls.length - 1].depth === depth) decls.pop();
    } else if (tok.value === ';') {
      while (decls.length && decls[decls.length - 1].depth >= depth) decls.pop();
    }
  }
  return { tokens, literals };
}

export function tableOf(src, name) {
  const tokens = tokenize(src);
  const at = tokens.findIndex((tok, k) => tok.type === 'name' && tok.value === name
    && ['const', 'let', 'var'].includes(tokens[k - 1]?.value) && tokens[k + 1]?.value === '=');
  if (at < 0) throw new Error(`no declaration of ${name}`);
  let depth = 0;
  let k = at + 2;
  for (; k < tokens.length; k++) {
    const v = tokens[k].type === 'punct' ? tokens[k].value : null;
    if (v === '(' || v === '[' || v === '{') depth++;
    else if (v === ')' || v === ']' || v === '}') depth--;
    else if (v === ';' && depth === 0) break;
  }
  return new Function(`"use strict"; return (${src.slice(tokens[at + 2].pos, tokens[k].pos)});`)();
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'source', 'track', 'wbr']);
const ENTITIES = { amp: 0x26, lt: 0x3c, gt: 0x3e, quot: 0x22, apos: 0x27, nbsp: 0xa0, hellip: 0x2026,
  mdash: 0x2014, ndash: 0x2013, middot: 0xb7, times: 0xd7, larr: 0x2190, rarr: 0x2192, uarr: 0x2191,
  darr: 0x2193, copy: 0xa9, bull: 0x2022 };

export function decodeEntities(s) {
  return s.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    const code = ENTITIES[e.toLowerCase()];
    return code ? String.fromCodePoint(code) : m;
  });
}

export function scanHtml(src) {
  const texts = [];
  const attrs = [];
  const stack = [];
  let i = 0;
  let line = 1;
  let inBody = false;
  const advance = (to) => {
    for (let k = i; k < to; k++) if (src[k] === '\n') line++;
    i = to;
  };
  while (i < src.length) {
    if (src.startsWith('<!--', i)) {
      advance(src.indexOf('-->', i) + 3);
      continue;
    }
    if (src[i] === '<' && /[!/a-z]/i.test(src[i + 1] || '')) {
      const end = src.indexOf('>', i);
      const from = line;
      const raw = src.slice(i + 1, end);
      advance(end + 1);
      if (raw[0] === '!') continue;
      if (raw[0] === '/') {
        const tag = raw.slice(1).trim().toLowerCase();
        while (stack.length && stack.pop().tag !== tag);
        if (tag === 'body') inBody = false;
        continue;
      }
      const tag = /^[a-z0-9-]+/i.exec(raw)[0].toLowerCase();
      const found = [];
      const re = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      re.lastIndex = tag.length;
      for (let m; (m = re.exec(raw));) {
        const at = from + (raw.slice(0, m.index).match(/\n/g) || []).length;
        found.push({ name: m[1].toLowerCase(), value: decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''), line: at });
      }
      if (tag === 'body') inBody = true;
      const i18n = found.find((a) => a.name === 'data-i18n')?.value ?? null;
      for (const a of found) attrs.push({ ...a, inBody, tag, i18n });
      if (tag === 'script' || tag === 'style') {
        advance(src.indexOf(`</${tag}`, i));
        continue;
      }
      if (!VOID.has(tag) && !raw.endsWith('/')) stack.push({ tag, i18n });
      continue;
    }
    const next = src.indexOf('<', i + 1);
    const to = next < 0 ? src.length : next;
    const raw = src.slice(i, to);
    const i18n = [...stack].reverse().find((e) => e.i18n != null)?.i18n ?? null;
    const lead = raw.match(/^\s*/)[0];
    texts.push({ text: decodeEntities(raw), line: line + (lead.match(/\n/g) || []).length, inBody, i18n });
    advance(to);
  }
  return { texts, attrs };
}
