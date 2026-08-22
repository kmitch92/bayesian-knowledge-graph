import { defineConfig } from 'tsup';

export default defineConfig({
  // Object form fixes the output basename: dist/kgmem.js (matches package.json "bin").
  entry: { kgmem: 'src/adapters/cli/index.ts' },
  outDir: 'dist',
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  dts: false,
  // Shebang so the built bundle runs directly as ./dist/kgmem.js
  banner: { js: '#!/usr/bin/env node' },
});
