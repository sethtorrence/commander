import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeSafeStorage } from './fake-safe-storage';
import { answerModelKeyRequest, createModelKeys } from './model-keys';
import { createSecrets } from './secrets';

const KEY = 'zai-key-7e3b9d21a0c4';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'commander-model-keys-'));
  file = join(dir, 'secrets.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const secretsOn = (backend?: string) =>
  createSecrets({ safeStorage: fakeSafeStorage({ backend }), file, platform: 'linux' });
// The Core borrows the key with the Accounts' access token request, naming the reserved id.
const askForKey = { type: 'access-token-request', id: 7, account: 'model-key:zai' };

describe('model API keys in the main process', () => {
  it('are saved through the keyring, never in plain text, and reported only as saved or not', async () => {
    const keys = createModelKeys(secretsOn());
    expect(await keys.status('zai')).toEqual({ saved: false });

    expect(await keys.save('zai', `  ${KEY}\n`)).toEqual({ ok: true });

    expect(await keys.status('zai')).toEqual({ saved: true });
    expect(await readFile(file, 'utf8')).not.toContain(KEY);
  });

  it('can be removed', async () => {
    const keys = createModelKeys(secretsOn());
    await keys.save('zai', KEY);

    await keys.clear('zai');

    expect(await keys.status('zai')).toEqual({ saved: false });
  });

  it('refuse something that is not a key', async () => {
    const keys = createModelKeys(secretsOn());

    expect(await keys.save('zai', '   ')).toMatchObject({ ok: false });
    expect(await keys.save('zai', 'two words')).toMatchObject({ ok: false });
    expect(await keys.save('openai' as 'zai', KEY)).toMatchObject({ ok: false });
    expect(await keys.status('zai')).toEqual({ saved: false });
  });

  it('refuse to save without a real keyring, saying why', async () => {
    const keys = createModelKeys(secretsOn('basic_text'));

    expect(await keys.save('zai', KEY)).toEqual({
      ok: false,
      error: expect.stringContaining('no system keyring'),
    });
  });
});

describe('the Core borrowing a model API key', () => {
  it('gets the saved key, as an API key', async () => {
    const secrets = secretsOn();
    await createModelKeys(secrets).save('zai', KEY);

    expect(await answerModelKeyRequest(secrets, askForKey)).toEqual({
      type: 'access-token-reply',
      id: 7,
      response: { ok: true, token: KEY, kind: 'api-key' },
    });
  });

  it('is told there is no key, and where to add one, when none is saved', async () => {
    expect(await answerModelKeyRequest(secretsOn(), askForKey)).toMatchObject({
      response: { ok: false, reason: 'unknown-account', error: expect.stringContaining('Settings → Ares') },
    });
  });

  it('is told why the keyring cannot be read', async () => {
    expect(await answerModelKeyRequest(secretsOn('basic_text'), askForKey)).toMatchObject({
      response: { ok: false, reason: 'unavailable', error: expect.stringContaining('no system keyring') },
    });
  });

  it('leaves Account token requests and other messages to their own handlers', () => {
    const secrets = secretsOn();

    expect(
      answerModelKeyRequest(secrets, { type: 'access-token-request', id: 8, account: 'org-1' }),
    ).toBeNull();
    expect(
      answerModelKeyRequest(secrets, { type: 'access-token-request', id: 9, account: 'model-key:nope' }),
    ).toBeNull();
    expect(answerModelKeyRequest(secrets, { type: 'heartbeat', beats: 1, at: 1 })).toBeNull();
  });
});
