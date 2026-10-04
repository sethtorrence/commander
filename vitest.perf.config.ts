import { defineConfig } from 'vitest/config';

// Speed checks (`*.perf.test.ts`): run alone, one file at a time, so their time budgets measure the
// code rather than whatever else the machine is doing. `pnpm test:perf`.
export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.perf.test.{ts,tsx}'],
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
