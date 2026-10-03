import { cpSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { parseBuildConfig } from './src/main/build-config';

// Workspace packages are TypeScript source, so they're bundled rather than externalized.
const bundleWorkspace = {
  exclude: ['@commander/domain', '@commander/core', '@commander/models', '@commander/sources'],
};
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

// The private build config (app client IDs): config/local.json if you made one, otherwise the
// committed config/example.json, which has none. Validated here so a typo fails the build.
function readBuildConfig() {
  const local = resolve(__dirname, '../../config/local.json');
  const file = existsSync(local) ? local : resolve(__dirname, '../../config/example.json');
  return parseBuildConfig(JSON.parse(readFileSync(file, 'utf8')));
}

export default defineConfig({
  main: {
    plugins: [copyCoreMigrations()],
    define: { __COMMANDER_BUILD_CONFIG__: JSON.stringify(readBuildConfig()) },
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
    plugins: [react(), tailwindcss()],
  },
});
