// Minimal zero-dependency static server for the production build. The game has
// to be served over HTTP rather than opened as a file, because file:// URLs
// can't fetch the JSON/atlas assets Phaser needs.
//
// Importable as startServer() (see tools/play.mjs) or runnable directly, in
// which case it serves ../dist, or $GAME_ROOT if set.
import { createServer } from 'node:http';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
};

/**
 * Serves `root` on the first free port at or after `startPort`.
 * Resolves to { url, port, server, close }.
 */
export function startServer({ root, startPort = 4173, host = '127.0.0.1' } = {}) {
  const ROOT = resolve(root);
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    // Resolve inside ROOT only — no path traversal out of dist/.
    const target = join(ROOT, normalize(urlPath));
    if (!target.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let file = target;
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
    } catch {
      res.writeHead(404).end('Not found');
      return;
    }

    let size;
    try {
      size = statSync(file).size;
    } catch {
      res.writeHead(404).end('Not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': size,
      'Cache-Control': 'no-cache',
    });
    createReadStream(file).pipe(res);
  });

  return new Promise((res, rej) => {
    // Walk forward if the port is taken (a stale copy, or a Vite preview).
    let port = startPort;
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && port < startPort + 20) server.listen(++port, host);
      else rej(err);
    });
    server.listen(port, host, () => {
      res({ url: `http://${host}:${port}/`, port, server, close: () => server.close() });
    });
  });
}

// Direct invocation: serve $GAME_ROOT (or ../dist) and print the URL, which the
// shell launchers read to learn where to point the browser.
const invokedDirectly = process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const root = process.env.GAME_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
  try {
    const { url } = await startServer({ root, startPort: Number(process.env.PORT) || 4173 });
    console.log(`READY ${url}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
