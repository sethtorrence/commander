import { randomBytes } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import type { SecretStorageStatus } from '@commander/domain/ipc';
import type { SafeStorage } from 'electron';

// Secrets (Account tokens, API keys) live only in the OS keyring, through Electron's safeStorage.
// The values are encrypted with a key the keyring holds; only the encrypted blobs reach the disk.
// This module stays in the main process: the window may learn the status, never a secret.

// The part of Electron's safeStorage this module uses, so tests can stand in a fake.
export type SafeStorageBackend = Pick<
  SafeStorage,
  'isEncryptionAvailable' | 'getSelectedStorageBackend' | 'encryptString' | 'decryptString'
>;

export type SecretsOptions = {
  safeStorage: SafeStorageBackend;
  // Where the encrypted blobs are kept, e.g. `secrets.json` under the app's userData folder.
  file: string;
  platform: NodeJS.Platform;
};

export type Secrets = {
  // Which keyring is in use and whether secrets are protected by it.
  status(): SecretStorageStatus;
  // Rejects with SecretStorageUnavailableError when no real keyring is available.
  save(key: string, value: string): Promise<void>;
  // Resolves null for a key that was never saved. Rejects when no real keyring is available.
  read(key: string): Promise<string | null>;
  // Always allowed, so removing an Account can clear its tokens even without a keyring.
  delete(key: string): Promise<void>;
};

export class SecretStorageUnavailableError extends Error {
  override name = 'SecretStorageUnavailableError';
}

const keyringFix =
  'install gnome-keyring (or another Secret Service provider, such as KeePassXC), make sure it starts ' +
  'with your session and is unlocked, then restart Commander. If you start Commander yourself, launch it ' +
  'with --password-store=gnome-libsecret.';

function secretStorageStatus(
  safeStorage: SafeStorageBackend,
  platform: NodeJS.Platform,
): SecretStorageStatus {
  const available = safeStorage.isEncryptionAvailable();
  if (platform !== 'linux') {
    const backend = platform === 'darwin' ? 'keychain' : platform === 'win32' ? 'dpapi' : 'unknown';
    const problem = available
      ? null
      : "Commander won't store sign-ins or API keys because the system keychain isn't available right now. Restart Commander, and check your system's keychain if it keeps happening.";
    return { backend, protected: available, problem };
  }

  const backend = safeStorage.getSelectedStorageBackend();
  if (backend === 'basic_text') {
    return {
      backend,
      protected: false,
      problem: `Commander won't store sign-ins or API keys because no system keyring was found, so they could only be saved unencrypted. To fix it, ${keyringFix}`,
    };
  }
  if (backend === 'unknown' || !available) {
    return {
      backend,
      protected: false,
      problem: `Commander won't store sign-ins or API keys because the system keyring can't encrypt them right now. To fix it, ${keyringFix}`,
    };
  }
  return { backend, protected: true, problem: null };
}

// Key -> base64 of the safeStorage-encrypted value.
type Blobs = Map<string, string>;

export function createSecrets({ safeStorage, file, platform }: SecretsOptions): Secrets {
  const status = (): SecretStorageStatus => secretStorageStatus(safeStorage, platform);

  function requireKeyring() {
    const { problem } = status();
    if (problem !== null) throw new SecretStorageUnavailableError(problem);
  }

  async function load(): Promise<Blobs> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw error;
    }
    return new Map(Object.entries(JSON.parse(text)));
  }

  // Write to a private temp file, flush it, then rename it over the old file, so a crash never
  // leaves a half-written store and the file is never readable by other users.
  async function store(blobs: Blobs) {
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(Object.fromEntries(blobs), null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  // One operation at a time, so concurrent saves can't overwrite each other.
  let queue: Promise<unknown> = Promise.resolve();
  function serially<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  return {
    status,
    save(key, value) {
      return serially(async () => {
        requireKeyring();
        const blobs = await load();
        blobs.set(key, safeStorage.encryptString(value).toString('base64'));
        await store(blobs);
      });
    },
    read(key) {
      return serially(async () => {
        requireKeyring();
        const blob = (await load()).get(key);
        return blob === undefined ? null : safeStorage.decryptString(Buffer.from(blob, 'base64'));
      });
    },
    delete(key) {
      return serially(async () => {
        const blobs = await load();
        if (!blobs.delete(key)) return;
        await store(blobs);
      });
    },
  };
}
