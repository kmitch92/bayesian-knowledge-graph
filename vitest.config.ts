import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Explicit imports from 'vitest' in every test file - no ambient globals.
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    // Insurance against worker contention, not a fix for a reproducible failure.
    // `ledger-scan.test.ts` builds 4,097 real rows in a `beforeAll`, and
    // `containment-retirement.test.ts` runs a 60-case fast-check property — both
    // slow because they test something real. Neither reproduced under ~38 direct
    // runs while diagnosing E1a, and E1a measured as the cause of neither; this
    // raises the ceiling for the rare case where a worker sharing the machine
    // pushes one of them past the 10s/5s defaults, observed once against
    // `ledger-scan.test.ts` under `pnpm exec vitest run src/store`.
    hookTimeout: 60_000, // default 10_000
    testTimeout: 30_000, // default 5_000
    coverage: {
      provider: 'v8',
      reporter: ['text'],
    },
  },
});
