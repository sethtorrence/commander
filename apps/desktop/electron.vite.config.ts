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
// sqlite-vec (search by meaning, #73) finds its loadable extension beside its own package, and
// onnxruntime-node (the embedding model) is a native module.
const nativeExternals = ['better-sqlite3', 'sqlite-vec', 'onnxruntime-node'];
// The email reader's sanitiser (in the Core) reads files of its own at runtime (jsdom's, css-tree's
// data), so it stays in node_modules too; listed in this app's dependencies for the same reason.
const sanitiserExternals = ['jsdom', 'dompurify', 'css-tree'];

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
        external: [...runtimeExternals, ...nativeExternals, ...sanitiserExternals],
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          core: resolve(__dirname, '../core/src/index.ts'),
          // The Core's email sanitiser runs in a worker thread of its own (email-reader/sanitiser.ts).
          'email-sanitiser': resolve(__dirname, '../core/src/email-reader/sanitise-worker.ts'),
          // And so does the embedding model, for search by meaning (meaning/embedder.ts).
          'embed-worker': resolve(__dirname, '../core/src/meaning/embed-worker.ts'),
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
