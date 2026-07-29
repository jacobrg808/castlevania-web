// One-command setup: install dependencies, then fetch and convert the original
// game's assets. Works on macOS, Windows and Linux — the only requirement is Node.
//
//   npm run setup
//
// Assets are not committed to this repo (they are Konami's — see README), so
// each user generates their own copy from the original C++ project, which does
// publish them.
//
// This deliberately does not build the macOS Castlevania.app — it would write to
// /Applications unasked. Run `npm run package-app` to opt into that.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache');
const UPSTREAM = join(CACHE, 'Castlevania-master');
const CONTENT = join(UPSTREAM, 'src', 'GameCuaTao', 'Castlevania', 'Content');
const TARBALL_URL = 'https://github.com/NearHuscarl/Castlevania/archive/refs/heads/master.tar.gz';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd, args, label) {
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (res.error?.code === 'ENOENT') {
    console.error(`\nerror: '${cmd}' is not available on this system.\n`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`\nerror: ${label} failed.\n`);
    process.exit(1);
  }
}

console.log('==> Installing dependencies');
run(npm, ['install', '--no-fund', '--no-audit'], 'npm install');

if (!existsSync(join(ROOT, 'public', 'assets'))) {
  if (!existsSync(CONTENT)) {
    console.log('==> Downloading the original game assets (~11 MB)');
    mkdirSync(CACHE, { recursive: true });
    const tarball = join(CACHE, 'upstream.tar.gz');

    const res = await fetch(TARBALL_URL);
    if (!res.ok) {
      console.error(`\nerror: download failed (HTTP ${res.status}).`);
      console.error('Check your connection, or clone the project manually and run:');
      console.error('  node tools/convert-assets.mjs /path/to/Castlevania-master\n');
      process.exit(1);
    }
    writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));

    // `tar` ships with macOS, Linux, and Windows 10+ (as bsdtar). Only the
    // Content tree is needed; the C++ sources are not.
    console.log('==> Extracting');
    run('tar', ['-xzf', tarball, '-C', CACHE,
      'Castlevania-master/src/GameCuaTao/Castlevania/Content'], 'extraction');
    rmSync(tarball, { force: true });
  }

  console.log('==> Converting assets');
  run(process.execPath, [join('tools', 'convert-assets.mjs'), UPSTREAM], 'asset conversion');
} else {
  console.log('==> Assets already present, skipping download');
}

console.log('\nSetup complete. Start the game with:\n');
console.log('  npm run play\n');
