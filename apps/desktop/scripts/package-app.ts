// Packages the built app (out/, from `electron-vite build`) into dist/linux-unpacked with electron-builder,
// configured in electron-builder.yml. Run through `pnpm package` (or `pnpm install:local`), never alone.
//
// It packages the Electron used for development: requiring the `electron` package fetches its binary if
// this checkout doesn't have it yet, and gives its path.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { build, Platform } from 'electron-builder';

const require = createRequire(import.meta.url);
const electronBinary = require('electron') as string;
const projectDir = resolve(import.meta.dirname, '..');
const unpacked = resolve(projectDir, 'dist/linux-unpacked');

await build({
  projectDir,
  targets: Platform.LINUX.createTarget('dir'),
  config: { electronDist: dirname(electronBinary) },
});

// Electron names the data folder after the package: renamed, the installed app would open an empty one.
const packaged = JSON.parse(readFileSync(join(unpacked, 'resources/app/package.json'), 'utf8'));
if (packaged.name !== '@commander/desktop' || 'productName' in packaged) {
  throw new Error('The packaged app would not use the data folder ~/.config/@commander/desktop.');
}

// What the Core loads at runtime, loaded by the packaged Electron's own Node: the database, its search
// by meaning extension and the embedding model's runtime.
const check = `
  const require = (await import('node:module')).createRequire(${JSON.stringify(join(unpacked, 'resources/app/out/main/core.js'))});
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  (await import(require.resolve('sqlite-vec'))).load(db);
  const vec = db.prepare('select vec_version() as version').get().version;
  require('onnxruntime-node').listSupportedBackends();
  console.log('better-sqlite3, sqlite-vec ' + vec + ' and onnxruntime-node load in Electron ' + process.versions.electron);
`;
const loaded = execFileSync(join(unpacked, 'commander'), ['--input-type=module', '-e', check], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
});
console.log(loaded.trim());
console.log(`Packaged Commander ${packaged.version} in ${unpacked}`);

// The client IDs are built in from config/local.json (electron.vite.config.ts); only whether it exists is
// checked here. Without it, Accounts can neither sign in nor refresh their sign-ins.
if (!existsSync(resolve(projectDir, '../../config/local.json'))) {
  console.warn(
    'No config/local.json: this build has no client IDs, so Accounts can’t sign in or stay signed in. See the README, “Build config”.',
  );
}
