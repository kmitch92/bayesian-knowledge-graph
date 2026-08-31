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
  // tsup bundles TypeScript and ignores .sql, but connection.ts resolves
  // migration 0 relative to import.meta.url — dist/migrations/ in the built
  // bundle. Copying keeps readFileSync the single, tested load path in both
  // development and production, rather than an esbuild text loader that would
  // have to be mirrored in vitest.config.ts and would split the two.
  onSuccess: 'mkdir -p dist/migrations && cp src/store/migrations/*.sql dist/migrations/',
});
