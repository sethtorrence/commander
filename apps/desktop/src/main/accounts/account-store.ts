import { randomBytes } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { accountSource, source } from '@commander/domain';
import type { AccountMethod, AccountSource, AccountStatus, CarriedSource } from '@commander/domain/ipc';
import { z } from 'zod';

// The signed-in Accounts of every Source, kept by the main process in a small JSON file next to the
// database (accounts.json under userData). Only what names an Account and its state lives here: its
// tokens and API keys are in the keyring, through the secrets module, under `credentialKey(id)`.

export type AccountRecord = {
  // Stable per Source identity, "<source>:…": "linear:<workspace id>", "teams:<tenant id>:<user id>".
  // Items carry it as their account.
  id: string;
  source: AccountSource;
  // What the User sees: a Linear workspace's name; "Teams · <user principal name>".
  name: string;
  method: AccountMethod;
  status: AccountStatus;
  connectedAt: number;
  // Who the User is at the Source (their Linear user; their Teams user). null for Linear Accounts
  // connected before Commander kept it, until it is found out (SourceAccounts.identifyUsers).
  user: { id: string; name: string } | null;
  // What only the Account's Source needs: Linear { urlKey }; Teams { tenantId, userPrincipalName };
  // Google { email }.
  details: Record<string, string>;
  // For an Account carrying several Sources (a Google Account's Gmail and Google Calendar): which
  // were granted, and which the User has on. Absent for single-Source Accounts.
  sources?: CarriedSource[];
};

export type AccountStore = {
  list(): Promise<AccountRecord[]>;
  get(id: string): Promise<AccountRecord | null>;
  put(account: AccountRecord): Promise<void>;
  remove(id: string): Promise<void>;
};

// The keyring key holding an Account's credential.
export const credentialKey = (accountId: string) => `account:${accountId}:credential`;

// The file's form. Version 1 (no envelope) was a bare list of Linear Accounts.
const VERSION = 2;

const user = z.object({ id: z.string(), name: z.string() });

const accountRecord = z.object({
  id: z.string().min(1),
  source: accountSource,
  name: z.string(),
  method: z.enum(['oauth', 'api-key']),
  status: z.enum(['connected', 'needs-reconnect']),
  connectedAt: z.number(),
  user: user.nullable(),
  details: z.record(z.string(), z.string()),
  sources: z.array(z.object({ source, granted: z.boolean(), enabled: z.boolean() })).optional(),
});

const currentFile = z.object({ version: z.literal(VERSION), accounts: z.array(accountRecord) });

// A Linear Account as version 1 kept it: its URL key alongside, and `user` missing until known.
const legacyFile = z.array(
  z
    .object({
      id: z.string().min(1),
      source: z.literal('linear'),
      name: z.string(),
      urlKey: z.string(),
      method: z.enum(['oauth', 'api-key']),
      status: z.enum(['connected', 'needs-reconnect']),
      connectedAt: z.number(),
      user: user.optional(),
    })
    .transform(
      ({ urlKey, user, ...account }): AccountRecord => ({
        ...account,
        user: user ?? null,
        details: { urlKey },
      }),
    ),
);

function readAccounts(text: string, file: string): AccountRecord[] {
  const raw: unknown = JSON.parse(text);
  const version = (raw as { version?: unknown } | null)?.version;
  if (typeof version === 'number' && version > VERSION) {
    throw new Error(
      `${file} was written by a newer version of Commander, so this one won't read or change it. Update Commander.`,
    );
  }
  const parsed = Array.isArray(raw) ? legacyFile.safeParse(raw) : currentFile.safeParse(raw);
  if (!parsed.success) throw new Error(`${file} is not readable: ${z.prettifyError(parsed.error)}`);
  return Array.isArray(parsed.data) ? parsed.data : parsed.data.accounts;
}

export function createAccountStore(file: string): AccountStore {
  async function load(): Promise<AccountRecord[]> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return readAccounts(text, file);
  }

  // Written to a private temp file and renamed over the old one, so a crash never leaves half a file.
  // An older file is rewritten in the current form here, the first time an Account changes.
  async function store(accounts: AccountRecord[]) {
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ version: VERSION, accounts }, null, 2));
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
