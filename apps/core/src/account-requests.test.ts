import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { answerRemoveAccountItems } from './account-requests';
import { type ItemStore, openItemStore } from './item-store';

let dir: string;
let store: ItemStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-account-requests-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../drizzle'),
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('removing an Account’s Items at the main process’s request', () => {
  it('deletes them as the User, saying which Account was removed', () => {
    store.saveFromSource({
      source: 'linear',
      account: 'linear:org-acme',
      items: [{ externalId: 'ENG-1', kind: 'linear-issue', title: 'Fix the build' }],
    });

    const reply = answerRemoveAccountItems(store, {
      type: 'remove-account-items',
      id: 7,
      source: 'linear',
      account: 'linear:org-acme',
      name: 'Acme',
    });

    expect(reply).toEqual({ type: 'remove-account-items-reply', id: 7, response: { ok: true, removed: 1 } });
    expect(store.query()).toEqual([]);
    expect(store.activity()[0]).toMatchObject({
      action: 'delete',
      by: { kind: 'user' },
      why: 'Removed the Linear Account Acme',
    });
  });

  it('stops the Account’s syncing before its Items go', () => {
    const order: string[] = [];
    store.saveFromSource({
      source: 'linear',
      account: 'linear:org-acme',
      items: [{ externalId: 'ENG-1', kind: 'linear-issue', title: 'Fix the build' }],
    });
    const request = {
      type: 'remove-account-items',
      id: 9,
      source: 'linear',
      account: 'linear:org-acme',
      name: 'Acme',
    };

    answerRemoveAccountItems(store, request, (account) => {
      order.push(`stop ${account}`, `items left: ${store.query().length}`);
    });

    expect(order).toEqual(['stop linear:org-acme', 'items left: 1']);
  });

  it('forgets what a removed GitHub Account watched', () => {
    store.githubWatch.save('github:583231', { orgs: [{ login: 'acme', except: [] }], repos: [] });

    answerRemoveAccountItems(store, {
      type: 'remove-account-items',
      id: 10,
      source: 'github',
      account: 'github:583231',
      name: 'octocat',
    });

    expect(store.githubWatch.read('github:583231').watch).toBeNull();
  });

  it('answers a malformed request with the reason', () => {
    const reply = answerRemoveAccountItems(store, { type: 'remove-account-items', id: 8, source: 'myspace' });

    expect(reply).toMatchObject({ type: 'remove-account-items-reply', id: 8, response: { ok: false } });
  });

  it('ignores other messages', () => {
    expect(answerRemoveAccountItems(store, { type: 'item-store-request', id: 1 })).toBeNull();
  });
});
