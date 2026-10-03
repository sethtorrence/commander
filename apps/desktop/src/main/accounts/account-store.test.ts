import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AccountRecord, createAccountStore } from './account-store';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'commander-accounts-'));
  file = join(dir, 'accounts.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const acme: AccountRecord = {
  id: 'linear:org-acme',
  source: 'linear',
  name: 'Acme',
  urlKey: 'acme',
  method: 'api-key',
  status: 'connected',
  connectedAt: 1,
};

describe('the Account store', () => {
  it('starts empty', async () => {
    expect(await createAccountStore(file).list()).toEqual([]);
  });

  it('keeps Accounts across restarts, in a file only the User can read', async () => {
    await createAccountStore(file).put(acme);

    expect(await createAccountStore(file).list()).toEqual([acme]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('replaces an Account put again under the same id', async () => {
    const store = createAccountStore(file);
    await store.put(acme);

    await store.put({ ...acme, name: 'Acme Inc', status: 'needs-reconnect' });

    expect(await store.list()).toEqual([{ ...acme, name: 'Acme Inc', status: 'needs-reconnect' }]);
  });

  it('removes an Account and keeps the others', async () => {
    const store = createAccountStore(file);
    const globex = { ...acme, id: 'linear:org-globex', name: 'Globex', urlKey: 'globex' };
    await store.put(acme);
    await store.put(globex);

    await store.remove(acme.id);

    expect(await store.list()).toEqual([globex]);
    expect(await store.get(acme.id)).toBeNull();
    expect(await store.get(globex.id)).toEqual(globex);
  });

  it('keeps every Account when several are put at once, leaving no temp files', async () => {
    const store = createAccountStore(file);

    await Promise.all(['a', 'b', 'c'].map((id) => store.put({ ...acme, id: `linear:${id}` })));

    expect((await store.list()).map((account) => account.id).sort()).toEqual([
      'linear:a',
      'linear:b',
      'linear:c',
    ]);
    expect(await readdir(dir)).toEqual(['accounts.json']);
  });
});
