import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
  method: 'api-key',
  status: 'connected',
  connectedAt: 1,
  user: { id: 'user-1', name: 'Sam Rivera' },
  details: { urlKey: 'acme' },
};

const teams: AccountRecord = {
  id: 'teams:tenant-1:user-9',
  source: 'teams',
  name: 'Teams · sam@contoso.test',
  method: 'oauth',
  status: 'connected',
  connectedAt: 2,
  user: { id: 'user-9', name: 'Sam Rivera' },
  details: { tenantId: 'tenant-1', userPrincipalName: 'sam@contoso.test' },
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

  it('keeps Accounts of several Sources side by side', async () => {
    const store = createAccountStore(file);
    await store.put(acme);
    await store.put(teams);

    expect(await createAccountStore(file).list()).toEqual([acme, teams]);
    expect(await store.get(teams.id)).toEqual(teams);
  });

  it('replaces an Account put again under the same id', async () => {
    const store = createAccountStore(file);
    await store.put(acme);

    await store.put({ ...acme, name: 'Acme Inc', status: 'needs-reconnect' });

    expect(await store.list()).toEqual([{ ...acme, name: 'Acme Inc', status: 'needs-reconnect' }]);
  });

  it('removes an Account and keeps the others', async () => {
    const store = createAccountStore(file);
    const globex = { ...acme, id: 'linear:org-globex', name: 'Globex', details: { urlKey: 'globex' } };
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

// Before Accounts covered several Sources, accounts.json was a bare list of Linear Accounts.
describe('an accounts.json from when Accounts were Linear only', () => {
  const legacy = [
    {
      id: 'linear:org-acme',
      source: 'linear',
      name: 'Acme',
      urlKey: 'acme',
      method: 'oauth',
      status: 'connected',
      connectedAt: 1,
      user: { id: 'user-1', name: 'Sam Rivera' },
    },
    // Connected before Commander kept who signed in.
    {
      id: 'linear:org-globex',
      source: 'linear',
      name: 'Globex',
      urlKey: 'globex',
      method: 'api-key',
      status: 'needs-reconnect',
      connectedAt: 2,
    },
  ];

  const migrated: AccountRecord[] = [
    { ...acme, method: 'oauth' },
    {
      id: 'linear:org-globex',
      source: 'linear',
      name: 'Globex',
      method: 'api-key',
      status: 'needs-reconnect',
      connectedAt: 2,
      user: null,
      details: { urlKey: 'globex' },
    },
  ];

  it('still lists every Account, as it was', async () => {
    await writeFile(file, JSON.stringify(legacy, null, 2));

    expect(await createAccountStore(file).list()).toEqual(migrated);
  });

  it('is rewritten in the current form the next time an Account changes, losing nothing', async () => {
    await writeFile(file, JSON.stringify(legacy, null, 2));

    await createAccountStore(file).put(teams);

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 2, accounts: [...migrated, teams] });
    expect(await createAccountStore(file).list()).toEqual([...migrated, teams]);
  });

  it('is left alone while nothing changes', async () => {
    const text = JSON.stringify(legacy, null, 2);
    await writeFile(file, text);

    await createAccountStore(file).list();

    expect(await readFile(file, 'utf8')).toBe(text);
  });
});

describe('an accounts.json Commander can’t read', () => {
  it('is refused, not overwritten, when a newer Commander wrote it', async () => {
    const newer = JSON.stringify({ version: 3, accounts: [] });
    await writeFile(file, newer);
    const store = createAccountStore(file);

    await expect(store.list()).rejects.toThrow(/newer version of Commander/);
    await expect(store.put(acme)).rejects.toThrow(/newer version of Commander/);
    expect(await readFile(file, 'utf8')).toBe(newer);
  });
});
