import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ipc } from '@commander/domain';
import { app, ipcMain, safeStorage } from 'electron';
import { createSecrets, type Secrets } from './secrets';

// Wires the secrets module into the app: encrypted blobs under userData, and the status
// (never a secret) for Settings → Security. Call once the app is ready.
export function setUpSecretStorage(): Secrets {
  const secrets = createSecrets({
    safeStorage,
    file: join(app.getPath('userData'), 'secrets.json'),
    platform: process.platform,
  });
  ipcMain.handle(ipc.secretStorageStatus, () => secrets.status());
  if (process.env.COMMANDER_SECRETS_SELF_TEST === '1') {
    (globalThis as { commanderSecretsSelfTest?: Promise<SelfTestReport> }).commanderSecretsSelfTest =
      selfTest();
  }
  return secrets;
}

export type SelfTestReport = {
  backend: string;
  protected: boolean;
  readBack: boolean;
  plaintextOnDisk: boolean;
  fileMode: string;
  goneAfterDelete: boolean;
  error: string | null;
};

// For the end-to-end tests only: a save → read → delete round trip through the real keyring, in a
// throwaway folder so the User's secrets are untouched. It reports facts, never the secret itself,
// and the report stays in the main process (the tests read it from there, not from the window).
async function selfTest(): Promise<SelfTestReport> {
  const dir = await mkdtemp(join(tmpdir(), 'commander-secrets-self-test-'));
  const file = join(dir, 'secrets.json');
  const secrets = createSecrets({ safeStorage, file, platform: process.platform });
  const value = randomBytes(24).toString('hex');
  const { backend, protected: isProtected } = secrets.status();
  const report: SelfTestReport = {
    backend,
    protected: isProtected,
    readBack: false,
    plaintextOnDisk: true,
    fileMode: '',
    goneAfterDelete: false,
    error: null,
  };
  try {
    await secrets.save('self-test', value);
    report.plaintextOnDisk = (await readFile(file, 'utf8')).includes(value);
    report.fileMode = ((await stat(file)).mode & 0o777).toString(8);
    report.readBack = (await secrets.read('self-test')) === value;
    await secrets.delete('self-test');
    report.goneAfterDelete = (await secrets.read('self-test')) === null;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return report;
}
