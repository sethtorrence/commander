import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeSafeStorage } from '../fake-safe-storage';
import { ACME, type FakeLinear, startFakeLinear } from '../linear/fake-linear-server';
import { createLinearAccounts, type LinearAccounts } from '../linear/linear-accounts';
import { createSecrets } from '../secrets';
import { createAccountStore } from './account-store';
import { answerAccountsRequest } from './accounts-requests';

let dir: string;
let linear: FakeLinear;
let accounts: LinearAccounts;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'commander-accounts-requests-'));
  linear = await startFakeLinear();
  accounts = createLinearAccounts({
    config: {
      clientId: null,
      port: await freePort(),
      authorizeUrl: linear.authorizeUrl,
      tokenUrl: linear.tokenUrl,
      apiUrl: linear.apiUrl,
    },
    secrets: createSecrets({
      safeStorage: fakeSafeStorage(),
      file: join(dir, 'secrets.json'),
      platform: 'linux',
    }),
    store: createAccountStore(join(dir, 'accounts.json')),
    openBrowser: async () => {},
    removeItems: async () => {},
  });
});

afterEach(async () => {
  await linear.close();
  await rm(dir, { recursive: true, force: true });
});

describe('Settings → Accounts requests from the window', () => {
  it('lists the Accounts and which ways of connecting this build offers', async () => {
    expect(await answerAccountsRequest(accounts, { op: 'list' })).toEqual({
      ok: true,
      state: { accounts: [], linearOAuth: false },
    });
  });

  it('connects an API key Account and answers with the new list, without the key', async () => {
    linear.addApiKey('lin_api_secret', ACME);

    const response = await answerAccountsRequest(accounts, {
      op: 'connect-linear',
      method: 'api-key',
      apiKey: 'lin_api_secret',
    });

    expect(response).toMatchObject({ ok: true, state: { accounts: [{ name: 'Acme', method: 'api-key' }] } });
    expect(JSON.stringify(response)).not.toContain('lin_api_secret');
  });

  it('answers a failure with its explanation, never echoing the key', async () => {
    const response = await answerAccountsRequest(accounts, {
      op: 'connect-linear',
      method: 'api-key',
      apiKey: 'lin_api_typo',
    });

    expect(response).toMatchObject({ ok: false, error: expect.stringMatching(/didn’t accept that API key/) });
    expect(JSON.stringify(response)).not.toContain('lin_api_typo');
  });

  it('says only API keys work when the build has no OAuth app', async () => {
    expect(await answerAccountsRequest(accounts, { op: 'connect-linear', method: 'oauth' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/API key/),
    });
  });

  it('removes an Account', async () => {
    linear.addApiKey('lin_api_secret', ACME);
    await accounts.connectWithApiKey('lin_api_secret');

    expect(await answerAccountsRequest(accounts, { op: 'remove', accountId: 'linear:org-acme' })).toEqual({
      ok: true,
      state: { accounts: [], linearOAuth: false },
    });
  });

  it('shows each Account’s sync status, and passes Sync now and the cadence to the Core', async () => {
    linear.addApiKey('lin_api_secret', ACME);
    await accounts.connectWithApiKey('lin_api_secret');
    const asked: string[] = [];
    const status = {
      account: 'linear:org-acme',
      source: 'linear' as const,
      activity: 'idle' as const,
      cadenceMinutes: 15,
      cadenceChoices: [15, 30, 60],
      lastSyncedAt: 1,
      nextSyncAt: 2,
      itemCount: 12,
      problem: null,
    };
    const sync = {
      status: (id: string) => (id === 'linear:org-acme' ? status : null),
      refresh: (id: string) => asked.push(`refresh ${id}`),
      setCadence: (id: string, minutes: number) => asked.push(`cadence ${id} ${minutes}`),
    };

    const synced = await answerAccountsRequest(
      accounts,
      { op: 'sync-now', accountId: 'linear:org-acme' },
      sync,
    );
    await answerAccountsRequest(
      accounts,
      { op: 'set-sync-cadence', accountId: 'linear:org-acme', minutes: 30 },
      sync,
    );

    expect(asked).toEqual(['refresh linear:org-acme', 'cadence linear:org-acme 30']);
    expect(synced).toMatchObject({ ok: true, state: { accounts: [{ name: 'Acme', sync: status }] } });
  });

  it('rejects a malformed request without echoing it', async () => {
    const response = await answerAccountsRequest(accounts, {
      op: 'connect-linear',
      method: 'api-key',
      apiKey: 42,
    });

    expect(response).toMatchObject({ ok: false, error: 'Commander did not understand that request.' });
  });
});
