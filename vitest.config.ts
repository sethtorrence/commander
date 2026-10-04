import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.test.{ts,tsx}'],
    // Speed checks run on their own with `pnpm test:perf` (vitest.perf.config.ts).
    exclude: ['**/node_modules/**', '**/*.perf.test.{ts,tsx}'],
  },
});
