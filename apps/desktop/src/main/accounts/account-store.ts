import { randomBytes } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import type { AccountMethod, AccountStatus } from '@commander/domain/ipc';

// The signed-in Accounts, kept by the main process in a small JSON file next to the database
// (accounts.json under userData). Only what names an Account and its state lives here: its
// tokens and API keys are in the keyring, through the secrets module, under `credentialKey(id)`.

export type AccountRecord = {
  // Stable per Source identity: for Linear, "linear:<workspace id>". Items carry it as their account.
  id: string;
  source: 'linear';
  // What the User sees: the workspace's name, and its URL key (linear.app/<urlKey>).
  name: string;
  urlKey: string;
  method: AccountMethod;
  status: AccountStatus;
  connectedAt: number;
};

export type AccountStore = {
  list(): Promise<AccountRecord[]>;
  get(id: string): Promise<AccountRecord | null>;
  put(account: AccountRecord): Promise<void>;
  remove(id: string): Promise<void>;
};

// The keyring key holding an Account's credential.
export const credentialKey = (accountId: string) => `account:${accountId}:credential`;

export function createAccountStore(file: string): AccountStore {
  async function load(): Promise<AccountRecord[]> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as AccountRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  // Written to a private temp file and renamed over the old one, so a crash never leaves half a file.
  async function store(accounts: AccountRecord[]) {
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(accounts, null, 2));
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

  let queue: Promise<unknown> = Promise.resolve();
  function serially<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  return {
    list: () => serially(load),
    get: (id) => serially(async () => (await load()).find((account) => account.id === id) ?? null),
    put: (account) =>
      serially(async () => {
        const accounts = await load();
        const index = accounts.findIndex((existing) => existing.id === account.id);
        if (index === -1) accounts.push(account);
        else accounts[index] = account;
        await store(accounts);
      }),
    remove: (id) =>
      serially(async () => {
        const accounts = await load();
        const kept = accounts.filter((account) => account.id !== id);
        if (kept.length !== accounts.length) await store(kept);
      }),
  };
}
