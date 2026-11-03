// Static dev server over the project root, used by the popup preview harness
// (tests/ui/preview.html) and the icon renderer. Local only.
// Usage: node tools/serve.mjs [port]   → http://127.0.0.1:<port>/tests/ui/preview.html

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

async function resolveFile(urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  const abs = join(ROOT, rel);
  if (!abs.startsWith(ROOT + sep)) return null;
  try {
    const s = await stat(abs);
    if (s.isFile()) return abs;
    if (s.isDirectory()) return join(abs, 'index.html');
  } catch { /* not found */ }
  return null;
}

export function startServer(port = 0) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = await resolveFile(url.pathname);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found: ' + url.pathname);
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2]) || 5178;
  startServer(port).then((s) => {
    console.log(`serving ${ROOT} at http://127.0.0.1:${s.address().port}/tests/ui/preview.html`);
  });
}
