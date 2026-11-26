import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { CHROME, ROOT, serveStatic, sleep } from './helpers.js';

// menu-view.js outside the extension: no chrome.runtime, the same three classic scripts a desktop picker loads.

let browser, site;

before(async () => {
  browser = await chromium.launch({ executablePath: CHROME, headless: !process.env.HEADED });
  site = await serveStatic(ROOT);
});
after(async () => {
  await browser?.close();
  await site?.close();
});

const VISIBLE_WAIT_MS = 900;

async function openPage() {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(site.origin + '/tests/fixtures/menu-view/index.html');
  return { page, errors };
}

function render(page, opts = {}) {
  return page.evaluate((o) => {
    if (window.__view) window.__view.destroy();
    window.__picked = [];
    window.__closed = 0;
    window.__queries = [];
    const { host, root } = globalThis.__akariShadowUi.makeHost();
    const rows = (o.rows || []).map((r, i) => ({ ...r, choose: () => window.__picked.push(i) }));
    const view = globalThis.__akariMenuView.render({
      root,
      rows,
      note: o.note ?? null,
      onClose: () => {
        window.__closed++;
        view.destroy();
      },
      getHost: () => host,
      header: o.header ?? null,
      search: o.search ? { placeholder: o.search.placeholder, value: o.search.value, onInput: (q) => window.__queries.push(q) } : null,
      ...(o.bracket ? { t: (s) => `[${s}]` } : {}),
    });
    if (!window.__keys) {
      window.__keys = true;
      document.addEventListener('keydown', (e) => {
        if (window.__view && window.__view.key(e)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }, true);
    }
    window.__view = view;
    window.__root = root;
  }, opts);
}

const shape = (page) => page.evaluate(() => {
  const menu = window.__root.querySelector('.menu');
  if (!menu) return null;
  return {
    role: menu.getAttribute('role'),
    children: [...menu.children].map((n) => n.className),
    rows: [...menu.querySelectorAll('.row')].map((r) => ({
      role: r.getAttribute('role'),
      tile: r.querySelector('.tile').textContent,
      hue: r.querySelector('.tile').style.getPropertyValue('--h'),
      title: r.querySelector('.t').textContent,
      sub: r.querySelector('.u')?.textContent ?? null,
    })),
    foot: [...menu.querySelector('.foot').children].map((n) => [n.className, n.textContent]),
    close: (() => {
      const x = menu.querySelector('.foot .x');
      return { title: x.title, label: x.getAttribute('aria-label'), type: x.type };
    })(),
    hi: [...menu.querySelectorAll('.row')].map((r) => r.classList.contains('hi')),
  };
});

const ROWS = [
  { glyph: 'G', hue: 40, title: 'GitHub', sub: 'alice' },
  { glyph: 'E', hue: 200, title: 'Example', sub: '' },
];

const rowCenter = (page, i) => page.evaluate((n) => {
  const r = window.__root.querySelectorAll('.row')[n].getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
}, i);

test('the menu has the same DOM as the extension menu', async () => {
  const { page, errors } = await openPage();
  await render(page, { rows: ROWS, note: 'note text' });
  assert.deepEqual(await shape(page), {
    role: 'listbox',
    children: ['note', 'row', 'row', 'foot'],
    rows: [
      { role: 'option', tile: 'G', hue: '40', title: 'GitHub', sub: 'alice' },
      { role: 'option', tile: 'E', hue: '200', title: 'Example', sub: null },
    ],
    foot: [['mark', '灯'], ['grow', ''], ['', '↑↓選択'], ['', '⏎入力'], ['x x-sm', '×']],
    close: { title: '閉じる (esc)', label: '閉じる', type: 'button' },
    hi: [false, false],
  });
  await render(page, { rows: [], note: 'locked' });
  const empty = await shape(page);
  assert.deepEqual(empty.children, ['note', 'foot']);
  assert.deepEqual(empty.foot.map(([c]) => c), ['mark', 'grow', 'x x-sm']);
  assert.deepEqual(errors, []);
  await page.close();
});

test('the t option replaces the menu labels', async () => {
  const { page } = await openPage();
  await render(page, { rows: ROWS, bracket: true });
  const s = await shape(page);
  assert.deepEqual(s.foot.slice(2, 4).map(([, text]) => text), ['↑↓[選択]', '⏎[入力]']);
  assert.deepEqual(s.close, { title: '[閉じる (esc)]', label: '[閉じる]', type: 'button' });
  await page.close();
});

test('Enter chooses only a highlighted row, and only after the menu has been visible', async () => {
  const { page } = await openPage();
  await render(page, { rows: ROWS });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.__picked), [], 'too early');

  await sleep(VISIBLE_WAIT_MS);
  await render(page, { rows: ROWS });
  await sleep(VISIBLE_WAIT_MS);
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.__picked), [], 'nothing highlighted');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert.deepEqual((await shape(page)).hi, [false, true]);
  await page.keyboard.press('ArrowDown');
  assert.deepEqual((await shape(page)).hi, [true, false], 'wraps');
  await page.keyboard.press('ArrowUp');
  assert.deepEqual((await shape(page)).hi, [false, true]);
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.__picked), [1]);
  await page.close();
});

test('Esc and the close button call onClose', async () => {
  const { page } = await openPage();
  await render(page, { rows: ROWS });
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.__closed), 1);
  assert.equal(await shape(page), null, 'destroy removes the menu');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.__picked), []);

  await render(page, { rows: ROWS });
  const at = await page.evaluate(() => {
    const r = window.__root.querySelector('.foot .x').getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  });
  await page.mouse.click(...at);
  assert.equal(await page.evaluate(() => window.__closed), 1, 'the close button does not wait for the guard');
  await page.close();
});

test('a click chooses a row only after the menu has been visible', async () => {
  const { page } = await openPage();
  await render(page, { rows: ROWS });
  await page.mouse.click(...(await rowCenter(page, 0)));
  assert.deepEqual(await page.evaluate(() => window.__picked), []);
  await sleep(VISIBLE_WAIT_MS);
  await page.mouse.click(...(await rowCenter(page, 1)));
  assert.deepEqual(await page.evaluate(() => window.__picked), [1]);
  await page.evaluate(() => window.__view.destroy());
  await page.mouse.click(5, 5);
  assert.deepEqual(await page.evaluate(() => window.__picked), [1]);
  await page.close();
});

test('reset() restarts the visible wait', async () => {
  const { page } = await openPage();
  await render(page, { rows: ROWS });
  await sleep(VISIBLE_WAIT_MS);
  await page.evaluate(() => window.__view.reset());
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.__picked), [], 'right after reset');
  await sleep(VISIBLE_WAIT_MS);
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.__picked), [0]);
  await page.close();
});

test('the optional header and search are added only when given', async () => {
  const { page, errors } = await openPage();
  const longPath = 'C:\\Program Files\\' + 'Very Long Folder Name\\'.repeat(6) + 'app.exe';
  await render(page, {
    rows: ROWS,
    header: {
      icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      name: 'Example App',
      path: longPath,
      signer: 'Example Corp',
      field: 'Username field',
      warnings: ['Signer changed', ''],
    },
    search: { placeholder: 'Search all' },
  });
  const head = await page.evaluate(() => {
    const h = window.__root.querySelector('.menu > .app-head');
    return {
      children: [...h.children].map((n) => n.className),
      ico: h.querySelector('.app-ico')?.getAttribute('src')?.slice(0, 22) ?? null,
      name: h.querySelector('.app-name').textContent,
      subs: [...h.querySelectorAll('.app-sub')].map((n) => [n.textContent, n.title]),
      warns: [...h.querySelectorAll('.app-warn')].map((n) => n.textContent),
    };
  });
  assert.deepEqual(head.children, ['app-id', 'app-warn']);
  assert.equal(head.ico, 'data:image/png;base64,');
  assert.equal(head.name, 'Example App');
  const [path, signer, field] = head.subs;
  assert.ok(path[0].includes('…') && Array.from(path[0]).length === 64, path[0]);
  assert.ok(path[0].startsWith('C:\\Program') && path[0].endsWith('app.exe'), path[0]);
  assert.equal(path[1], longPath);
  assert.deepEqual(signer, ['Example Corp', '']);
  assert.deepEqual(field, ['Username field', '']);
  assert.deepEqual(head.warns, ['Signer changed']);
  const s = await shape(page);
  assert.deepEqual(s.children, ['app-head', 'find', 'row', 'row', 'foot']);
  const find = await page.evaluate(() => {
    const i = window.__root.querySelector('.find');
    return { type: i.type, placeholder: i.placeholder, label: i.getAttribute('aria-label'), same: i === window.__view.input };
  });
  assert.deepEqual(find, { type: 'search', placeholder: 'Search all', label: 'Search all', same: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test('only a PNG data URL becomes the header icon', async () => {
  const { page } = await openPage();
  for (const icon of ['javascript:alert(1)', 'https://example.com/a.png', 'data:image/svg+xml;base64,PHN2Zz4=', 42]) {
    await render(page, { rows: ROWS, header: { icon, name: 'x' } });
    assert.equal(await page.evaluate(() => window.__root.querySelectorAll('img').length), 0, String(icon));
    await page.evaluate(() => window.__view.destroy());
  }
  await page.close();
});

test('the search box reports input, and setRows keeps it and the footer', async () => {
  const { page } = await openPage();
  await render(page, { rows: ROWS, search: { placeholder: 'Search' } });
  await page.evaluate(() => window.__view.input.focus());
  await page.keyboard.type('gi');
  assert.deepEqual(await page.evaluate(() => window.__queries), ['g', 'gi']);
  await sleep(VISIBLE_WAIT_MS);
  await page.keyboard.press('ArrowDown');
  assert.deepEqual((await shape(page)).hi, [true, false]);
  await page.evaluate(() => {
    window.__before = window.__view.input;
    window.__view.setRows([{ glyph: 'X', hue: 1, title: 'Only', sub: 'one', choose: () => window.__picked.push('x') }], 'filtered');
  });
  const s = await shape(page);
  assert.deepEqual(s.children, ['find', 'note', 'row', 'foot']);
  assert.deepEqual(s.hi, [false], 'the highlight resets');
  assert.deepEqual(await page.evaluate(() => [
    window.__view.input === window.__before,
    window.__root.activeElement === window.__view.input,
    window.__view.input.value,
  ]), [true, true, 'gi']);
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.__picked), [], 'nothing highlighted after setRows');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.__picked), ['x'], 'setRows keeps the visible wait');
  await page.evaluate(() => window.__view.setRows([]));
  assert.deepEqual((await shape(page)).foot.map(([c]) => c), ['mark', 'grow', 'x x-sm']);
  await page.close();
});

test('shadow-ui exposes the guard timing', async () => {
  const { page } = await openPage();
  assert.deepEqual(await page.evaluate(() => ({
    timing: { ...globalThis.__akariShadowUi.timing },
    frozen: Object.isFrozen(globalThis.__akariShadowUi.timing),
    view: Object.isFrozen(globalThis.__akariMenuView),
  })), { timing: { VISIBLE_MS: 500, MIN_VISIBLE_RATIO: 0.5, OCCLUSION_CHECK_DELAY_MS: 100 }, frozen: true, view: true });
  await page.close();
});
