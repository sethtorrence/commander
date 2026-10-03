import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// Workspace packages are TypeScript source, so they're bundled rather than externalized.
const bundleWorkspace = { exclude: ['@commander/domain', '@commander/core'] };
// `electron` is provided by the runtime and must never be bundled.
const runtimeExternals = ['electron', /^node:/];

export default defineConfig({
  main: {
    build: {
      externalizeDeps: bundleWorkspace,
      rollupOptions: {
        external: runtimeExternals,
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
