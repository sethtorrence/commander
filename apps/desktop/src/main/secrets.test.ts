import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSecrets, type SafeStorageBackend, SecretStorageUnavailableError } from './secrets';

// Stands in for Electron's safeStorage: "encrypts" by flipping bits so plain text never survives.
function fakeSafeStorage(options: { backend?: string; available?: boolean } = {}): SafeStorageBackend {
  const flip = (bytes: Buffer) => Buffer.from(bytes.map((byte) => byte ^ 0x5a));
  return {
    isEncryptionAvailable: () => options.available ?? true,
    getSelectedStorageBackend: () =>
      (options.backend ?? 'gnome_libsecret') as ReturnType<SafeStorageBackend['getSelectedStorageBackend']>,
    encryptString: (plainText) => flip(Buffer.from(`sealed:${plainText}`)),
    decryptString: (encrypted) =>
      flip(encrypted)
        .toString()
        .replace(/^sealed:/, ''),
  };
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'commander-secrets-'));
  file = join(dir, 'secrets.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('secrets on a real keyring', () => {
  it('reads back a saved secret', async () => {
    const secrets = createSecrets({ safeStorage: fakeSafeStorage(), file, platform: 'linux' });

    await secrets.save('account:gmail-1:refresh-token', 'r3fr3sh');

    expect(await secrets.read('account:gmail-1:refresh-token')).toBe('r3fr3sh');
  });

  it('reads nothing for a key that was never saved', async () => {
    const secrets = createSecrets({ safeStorage: fakeSafeStorage(), file, platform: 'linux' });

    expect(await secrets.read('account:linear-1:api-key')).toBeNull();
  });

  it('forgets a deleted secret and keeps the others', async () => {
    const secrets = createSecrets({ safeStorage: fakeSafeStorage(), file, platform: 'linux' });
    await secrets.save('account:gmail-1:refresh-token', 'one');
    await secrets.save('account:gmail-2:refresh-token', 'two');

    await secrets.delete('account:gmail-1:refresh-token');

    expect(await secrets.read('account:gmail-1:refresh-token')).toBeNull();
    expect(await secrets.read('account:gmail-2:refresh-token')).toBe('two');
  });

  it('deleting a key that was never saved is fine', async () => {
    const secrets = createSecrets({ safeStorage: fakeSafeStorage(), file, platform: 'linux' });

    await expect(secrets.delete('account:github-1:token')).resolves.toBeUndefined();
  });

  it('replaces a secret saved again under the same key', async () => {
    const secrets = createSecrets({ safeStorage: fakeSafeStorage(), file, platform: 'linux' });
    await secrets.save('account:linear-1:api-key', 'old');

    await secrets.save('account:linear-1:api-key', 'new');

    expect(await secrets.read('account:linear-1:api-key')).toBe('new');
  });

  it('keeps secrets across restarts', async () => {
    const before = createSecrets({ safeStorage: fakeSafeStorage(), file, platform: 'linux' });
    await before.save('account:linear-1:api-key', 'lin_api_123');

    const after = createSecrets({ safeStorage: fakeSafeStorage(), file, platform: 'linux' });

    expect(await after.read('account:linear-1:api-key')).toBe('lin_api_123');
  });

  it('keeps every secret when several are saved at once', async () => {
    const secrets = createSecrets({ safeStorage: fakeSafeStorage(), file, platform: 'linux' });

    await Promise.all(['a', 'b', 'c', 'd'].map((id) => secrets.save(`account:${id}:token`, `token-${id}`)));

    for (const id of ['a', 'b', 'c', 'd'])
      expect(await secrets.read(`account:${id}:token`)).toBe(`token-${id}`);
  });

  it('writes only encrypted values, in a file only the User can read', async () => {
    const secrets = createSecrets({ safeStorage: fakeSafeStorage(), file, platform: 'linux' });

    await secrets.save('account:gmail-1:refresh-token', 'very-secret-token');

    expect(await readFile(file, 'utf8')).not.toContain('very-secret-token');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['secrets.json']);
  });

  it('reports the keyring backend as protected', () => {
    const secrets = createSecrets({ safeStorage: fakeSafeStorage(), file, platform: 'linux' });

    expect(secrets.status()).toEqual({ backend: 'gnome_libsecret', protected: true, problem: null });
  });
});

describe('secrets without a real keyring', () => {
  it('refuses to save when only the plain-text store is available, and explains the fix', async () => {
    const secrets = createSecrets({
      safeStorage: fakeSafeStorage({ backend: 'basic_text' }),
      file,
      platform: 'linux',
    });

    const saving = secrets.save('account:gmail-1:refresh-token', 'very-secret-token');

    await expect(saving).rejects.toBeInstanceOf(SecretStorageUnavailableError);
    await expect(saving).rejects.toThrow(/gnome-keyring/);
    await expect(saving).rejects.toThrow(/--password-store=gnome-libsecret/);
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses to save when encryption is unavailable', async () => {
    const secrets = createSecrets({
      safeStorage: fakeSafeStorage({ available: false }),
      file,
      platform: 'linux',
    });

    await expect(secrets.save('account:gmail-1:refresh-token', 'token')).rejects.toThrow(
      SecretStorageUnavailableError,
    );
    expect(await readdir(dir)).toEqual([]);
  });

  it('reports the plain-text store as unprotected, with the same explanation', () => {
    const secrets = createSecrets({
      safeStorage: fakeSafeStorage({ backend: 'basic_text' }),
      file,
      platform: 'linux',
    });

    const status = secrets.status();

    expect(status).toMatchObject({ backend: 'basic_text', protected: false });
    expect(status.problem).toMatch(/gnome-keyring/);
  });

  it('reports an unavailable keyring as unprotected', () => {
    const secrets = createSecrets({
      safeStorage: fakeSafeStorage({ available: false }),
      file,
      platform: 'linux',
    });

    expect(secrets.status()).toMatchObject({ backend: 'gnome_libsecret', protected: false });
    expect(secrets.status().problem).toMatch(/unlock/);
  });

  it('refuses to read, but can still delete, secrets saved while the keyring worked', async () => {
    await createSecrets({ safeStorage: fakeSafeStorage(), file, platform: 'linux' }).save(
      'account:gmail-1:refresh-token',
      'token',
    );
    const secrets = createSecrets({
      safeStorage: fakeSafeStorage({ backend: 'basic_text' }),
      file,
      platform: 'linux',
    });

    await expect(secrets.read('account:gmail-1:refresh-token')).rejects.toThrow(
      SecretStorageUnavailableError,
    );
    await secrets.delete('account:gmail-1:refresh-token');
    expect(await readFile(file, 'utf8')).not.toContain('account:gmail-1');
  });
});

describe('secrets on macOS and Windows', () => {
  it('uses the Keychain on macOS', () => {
    const secrets = createSecrets({ safeStorage: fakeSafeStorage(), file, platform: 'darwin' });

    expect(secrets.status()).toEqual({ backend: 'keychain', protected: true, problem: null });
  });

  it('refuses to save on Windows when data protection is unavailable', async () => {
    const secrets = createSecrets({
      safeStorage: fakeSafeStorage({ available: false }),
      file,
      platform: 'win32',
    });

    expect(secrets.status()).toMatchObject({ backend: 'dpapi', protected: false });
    await expect(secrets.save('account:outlook-1:refresh-token', 'token')).rejects.toThrow(
      SecretStorageUnavailableError,
    );
  });
});
