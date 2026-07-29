// Builds the game if needed, serves it, and opens it in the default browser.
// Works on macOS, Windows and Linux — the only requirement is Node.
//
//   npm run play
//
// Stays in the foreground; Ctrl-C (or closing the terminal) stops the server.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve-dist.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function fail(message) {
  console.error(`\nerror: ${message}\n`);
  process.exit(1);
}

/** Newest mtime under a file or directory tree. */
function newestMtime(path) {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return readdirSync(path).reduce(
    (max, entry) => Math.max(max, newestMtime(join(path, entry))),
    stat.mtimeMs,
  );
}

if (!existsSync(join(ROOT, 'public', 'assets'))) {
  fail("game assets are missing. Run 'npm run setup' first.");
}

// Rebuild when dist/ is missing or any source file is newer than it.
const built = newestMtime(join(DIST, 'index.html'));
const sources = ['src', 'index.html', 'package.json', 'tsconfig.json']
  .reduce((max, p) => Math.max(max, newestMtime(join(ROOT, p))), 0);

if (!built || sources > built) {
  console.log('==> Building');
  const build = spawnSync(npm, ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (build.status !== 0) fail('build failed');
}

const { url } = await startServer({ root: DIST }).catch((err) => fail(err.message));
console.log(`\n  Castlevania is running at ${url}`);
console.log('  Press Ctrl-C to stop.\n');

// Hand the URL to whatever the OS considers the default browser.
const opener = {
  darwin: ['open', [url]],
  win32: ['cmd', ['/c', 'start', '""', url]],
}[process.platform] ?? ['xdg-open', [url]];

const child = spawn(opener[0], opener[1], { stdio: 'ignore', detached: true });
child.on('error', () => {
  console.log(`  (could not open a browser automatically — visit ${url})`);
});
child.unref();
