import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

// Workspace packages are TypeScript source, so they're bundled rather than externalized.
const bundleWorkspace = { exclude: ['@commander/domain', '@commander/core'] };
// `electron` is provided by the runtime and must never be bundled.
const runtimeExternals = ['electron', /^node:/];
// Native modules load their binary from their own package folder, so they stay in node_modules.
// They must be listed in this app's dependencies so the bundle can resolve them at runtime.
const nativeExternals = ['better-sqlite3'];

// The Core applies its database migrations at start-up from a folder next to its bundle.
function copyCoreMigrations(): Plugin {
  return {
    name: 'commander:copy-core-migrations',
    writeBundle(output) {
      cpSync(resolve(__dirname, '../core/drizzle'), resolve(output.dir ?? 'out/main', 'migrations'), {
        recursive: true,
      });
    },
  };
}

export default defineConfig({
  main: {
    plugins: [copyCoreMigrations()],
    build: {
      externalizeDeps: bundleWorkspace,
      rollupOptions: {
        external: [...runtimeExternals, ...nativeExternals],
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          core: resolve(__dirname, '../core/src/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: { external: runtimeExternals, output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    plugins: [react()],
  },
});
