import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.test.{ts,tsx}', 'apps/*/scripts/**/*.test.ts'],
    // Speed checks run on their own with `pnpm test:perf` (vitest.perf.config.ts).
    exclude: ['**/node_modules/**', '**/*.perf.test.{ts,tsx}'],
    // A rendered Section's test takes about a second alone but 6–8 when several suites share the
    // machine, past the 5-second default; 15 seconds still catches a test that hangs.
    testTimeout: 15_000,
  },
});
