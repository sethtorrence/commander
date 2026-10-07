import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, LinearIssueDetail } from '@commander/domain';
import { createModelClient, ModelError } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openGate } from '../autonomy/gate';
import { HELD_AFTER_RESTORE } from '../backups/restore';
import { type ItemStore, openItemStore } from '../item-store';
import { setUpUpdates, type Updates } from '.';

// Changes that didn't reach a Source, in the Update (#206): one Needs you now line per Account and
// Source, in Commander's own words from the changes' data, with Retry on the line and on each Item;
// it clears once the changes go through or are discarded.

const ACME = 'linear:org-acme';
const user: ActionContext = { by: { kind: 'user' } };
const progress = { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' };
const review = { id: 'state-review', name: 'In Review', type: 'started', color: '#5e6ad2' };

let dir: string;
let clock: number;
let store: ItemStore;
let updates: Updates;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-couldnt-sync-'));
  clock = new Date(2026, 9, 3, 10, 0).getTime();
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  updates = setUpUpdates({
    itemStore: store,
    gate: openGate({ itemStore: store }),
    // The line is Commander's own words: no model is asked for it.
    client: createModelClient({
      settings: () => store.models.settings(),
      providers: {
        zai: {
          send: () => Promise.reject(new ModelError('no-key', 'No API key is saved for Z.ai.')),
          stream: () => Promise.reject(new Error('not used')),
        },
      },
      ledger: store.models,
      now: () => clock,
    }),
    now: () => clock,
    accounts: () => [{ account: ACME, sources: ['linear'], name: 'Acme', needsReconnect: false }],
  });
  store.saveFromSource({
    source: 'linear',
    account: ACME,
    items: [
      issue('issue-418', 'ENG-418', 'Fix the login loop'),
      issue('issue-420', 'ENG-420', 'Rotate keys'),
    ],
  });
});

afterEach(() => {
  updates.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function issue(externalId: string, identifier: string, title: string) {
  const detail: LinearIssueDetail = {
    kind: 'linear-issue',
    identifier,
    url: `https://linear.app/acme/issue/${identifier}`,
    team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
    state: progress,
    priority: 2,
    assignee: null,
    creator: null,
    labels: [],
    cycle: null,
    linearProject: null,
    dueDate: null,
    estimate: null,
    description: null,
    comments: [],
    createdAt: 1,
    updatedAt: 1,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
  };
  return { externalId, kind: 'linear-issue' as const, title, detail };
}

const idOf = (identifier: string) =>
  store
    .query({ kinds: ['linear-issue'] })
    .find((item) => item.detail?.kind === 'linear-issue' && item.detail.identifier === identifier)
    ?.id as string;
const edit = (identifier: string, fields: Record<string, unknown>) =>
  store.record({ type: 'edit-fields', itemId: idOf(identifier), fields }, user);
// What the sync engine does when Linear refuses them: they stop as Couldn't sync.
function refuse(error = 'The issue is locked for editing.') {
  const ids = store.outgoing
    .rows()
    .filter((row) => row.status !== 'failed')
    .map((row) => row.id);
  store.outgoing.fail(ids, { error, failed: true, nextAttemptAt: null });
}
const lines = () => updates.queue.list().filter((line) => line.about.kind === 'couldnt-sync');

describe('changes that couldn’t sync, in the Update', () => {
  it('make one Needs you now line in Commander’s words, each Item with Retry', async () => {
    edit('ENG-418', { state: review });
    refuse();
    updates.sweep();

    const view = await updates.give();
    const [line] = view?.lines ?? [];
    expect(line).toMatchObject({ group: 'now', kind: 'couldnt-sync', section: 'linear' });
    expect(line?.text).toBe(
      'A change you made didn’t reach Linear (Acme): moving ENG-418 to In Review. It stays as you made it in Commander until it goes through. Retry it, or discard it in Settings → Accounts to go back to what Linear has.',
    );
    expect(line?.rows).toEqual([
      expect.objectContaining({
        label: 'ENG-418',
        title: 'Fix the login loop',
        state: 'Couldn’t sync: Move to In Review',
        actions: ['open', 'retry'],
      }),
    ]);
  });

  it('merge the Account’s changes into its one line as more stop', async () => {
    edit('ENG-418', { state: review });
    refuse();
    updates.sweep();
    edit('ENG-420', { priority: 1 });
    refuse();
    updates.sweep();

    expect(lines()).toHaveLength(1);
    const view = await updates.give();
    expect(view?.lines[0]?.text).toMatch(
      /^2 changes you made didn’t reach Linear \(Acme\): moving ENG-418 to In Review and setting the priority of ENG-420 to Urgent\. They stay as you made them/,
    );
    expect(view?.lines[0]?.rows.map((row) => row.label)).toEqual(['ENG-418', 'ENG-420']);
  });

  it('go again with the line’s Retry, which stays until they go through', () => {
    edit('ENG-418', { state: review });
    refuse();
    updates.sweep();
    const [line] = lines();

    updates.act(line?.id as number, 'retry');
    expect(store.outgoing.rows().map((row) => row.status)).toEqual(['pending']);
    updates.sweep();
    expect(lines()).toHaveLength(1);

    // It reached Linear: the line has nothing left to say.
    store.outgoing.settle(store.outgoing.rows().map((row) => row.id));
    updates.sweep();
    expect(lines()).toEqual([]);
    expect(store.updates.line(line?.id as number)?.status).toBe('resolved');
  });

  it('retry one Item from its row, and show it on its way again', async () => {
    edit('ENG-418', { state: review });
    edit('ENG-420', { priority: 1 });
    refuse();
    updates.sweep();
    const [line] = lines();

    updates.actRow(line?.id as number, idOf('ENG-420'), 'retry');
    expect(store.outgoing.rows().map((row) => [row.field, row.status])).toEqual([
      ['state', 'failed'],
      ['priority', 'pending'],
    ]);
    const view = await updates.give();
    expect(view?.lines[0]?.rows.map((row) => [row.label, row.state, row.actions])).toEqual([
      ['ENG-418', 'Couldn’t sync: Move to In Review', ['open', 'retry']],
      ['ENG-420', 'Trying again: Set the priority to Urgent', ['open']],
    ]);
  });

  it('clear once they are discarded', () => {
    edit('ENG-418', { state: review });
    refuse();
    updates.sweep();
    store.discardChanges(
      store.outgoing.rows().map((row) => row.id),
      user,
    );
    updates.sweep();
    expect(lines()).toEqual([]);
  });

  it('dismissed, aren’t queued again; a change that stops later starts a new line', () => {
    edit('ENG-418', { state: review });
    refuse();
    updates.sweep();
    updates.act(lines()[0]?.id as number, 'dismiss');
    updates.sweep();
    expect(lines()).toEqual([]);

    edit('ENG-420', { priority: 1 });
    refuse();
    updates.sweep();
    expect(lines().map((line) => line.itemIds)).toEqual([[idOf('ENG-420')]]);
  });

  it('say when they were held after a restore, to check the Source first', async () => {
    edit('ENG-418', { state: review });
    refuse(HELD_AFTER_RESTORE);
    updates.sweep();
    const view = await updates.give();
    expect(view?.lines[0]?.text).toContain(
      'It was held after a restore and may already be in Linear, so check there before you retry.',
    );
  });
});
