import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACME, type FakeLinear, startFakeLinear } from './fake-linear-server';
import { authorizationFor, readWorkspace } from './workspace';

let linear: FakeLinear;

beforeEach(async () => {
  linear = await startFakeLinear();
});

afterEach(async () => {
  await linear.close();
});

describe('reading which workspace a credential belongs to', () => {
  it('names the workspace of a personal API key', async () => {
    linear.addApiKey('lin_api_good', ACME);

    const workspace = await readWorkspace({
      apiUrl: linear.apiUrl,
      credential: { kind: 'api-key', apiKey: 'lin_api_good' },
    });

    expect(workspace).toEqual({ id: 'org-acme', name: 'Acme', urlKey: 'acme' });
  });

  it('refuses a key Linear does not accept', async () => {
    await expect(
      readWorkspace({ apiUrl: linear.apiUrl, credential: { kind: 'api-key', apiKey: 'lin_api_wrong' } }),
    ).rejects.toMatchObject({ reason: 'invalid-credential' });
  });

  it('explains when Linear cannot be reached', async () => {
    await linear.close();

    await expect(
      readWorkspace({ apiUrl: linear.apiUrl, credential: { kind: 'api-key', apiKey: 'lin_api_good' } }),
    ).rejects.toMatchObject({ reason: 'unreachable' });
    linear = await startFakeLinear();
  });

  it('sends OAuth tokens as Bearer and personal API keys as they are, as Linear expects', () => {
    expect(authorizationFor({ kind: 'oauth', accessToken: 'abc' })).toBe('Bearer abc');
    expect(authorizationFor({ kind: 'api-key', apiKey: 'lin_api_abc' })).toBe('lin_api_abc');
  });
});
