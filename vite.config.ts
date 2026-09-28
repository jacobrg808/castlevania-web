import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs so the build works wherever it is served from — the
  // site root locally (npm run play, Castlevania.app) and a subpath on GitHub
  // Pages (/<repo>/). An absolute base would 404 the bundle on Pages; Phaser's
  // own loader is already relative via setPath('assets').
  base: './',
});
