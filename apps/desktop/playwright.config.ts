import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  // Several suites often run at once on this machine (parallel branches); give assertions room under load.
  expect: { timeout: 10_000 },
  // Every test launches a full Electron app, and Commander holds a single-instance lock: run one at a time.
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
});
