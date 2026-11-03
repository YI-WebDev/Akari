// Shared E2E helpers: launch Playwright Chromium with the unpacked extension,
// find its id, talk to the service worker from an extension page, serve fixtures.

import { chromium } from 'playwright';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const EXT_DIR = path.join(ROOT, 'extension');
export const MASTER = 'correct horse battery staple 42';

// Branded Chrome (137+) ignores --load-extension, and Playwright's bundled Chromium
// does not start on this machine, so load the unpacked extension over CDP instead.
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

export async function launch() {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'akari-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME,
    headless: !process.env.HEADED,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'],
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id: extensionId } = await cdp.send('Extensions.loadUnpacked', { path: EXT_DIR });
  let sw = context.serviceWorkers().find((w) => w.url().includes(extensionId));
  if (!sw) sw = await context.waitForEvent('serviceworker', { predicate: (w) => w.url().includes(extensionId), timeout: 15000 });
  const errors = [];
  context.on('weberror', (e) => errors.push(String(e.error())));
  return {
    context,
    sw,
    extensionId,
    errors,
    url: (p) => `chrome-extension://${extensionId}/${p}`,
    async close() {
      await context.close();
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

/** Open an extension page and return a function that sends runtime messages from it. */
export async function extensionMessenger(ext) {
  const page = await ext.context.newPage();
  await page.goto(ext.url('src/passkey/passkey.html'));
  const send = (type, payload = {}) =>
    page.evaluate(([t, p]) => chrome.runtime.sendMessage({ ...p, type: t }), [type, payload]);
  return { page, send };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

/** Static file server over a directory, on localhost with an ephemeral port. */
export async function serveStatic(dir) {
  const server = createServer(async (req, res) => {
    try {
      const p = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!p.startsWith(dir)) throw new Error('outside');
      const body = await readFile(p);
      res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  // No host: dual-stack, so "localhost" works whether it resolves to ::1 or 127.0.0.1.
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  return { origin: `http://localhost:${port}`, close: () => new Promise((r) => server.close(r)) };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
