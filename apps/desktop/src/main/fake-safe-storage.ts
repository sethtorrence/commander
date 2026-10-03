import type { SafeStorageBackend } from './secrets';

// For tests: stands in for Electron's safeStorage, "encrypting" by flipping bits so plain text
// never survives on disk.
export function fakeSafeStorage(options: { backend?: string; available?: boolean } = {}): SafeStorageBackend {
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
