import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActionContext,
  type Enqueue,
  type LinearIssueDetail,
  lastChangedAt,
  type SourceItem,
} from '@commander/domain';
import { createModelClient, ModelError, type ModelProviderAdapter } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { setUpUpdates, type Updates, type WatchedAccount } from '.';

// Ares keeps an eye on Linear (#75), through the Updates' interface on a real Item store: Linear
// Todos leaving the User's list (a sync saving their issues reassigned) become one For your
// information line; an Account needing reconnecting queues one line that clears once reconnected;
// and a stuck-issue line (as the job queues it) expires once the issue changes. No model key: the
// plain sentences.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ACME = 'linear:org-acme';
const me = { id: 'user-sam', name: 'Sam Rivera', displayName: 'sam', email: null };
const priya = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: null };
const dana = { id: 'user-dana', name: 'Dana Kim', displayName: 'dana', email: null };
const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' };
const TODO = { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' };
const REVIEW = { id: 'state-review', name: 'In Review', type: 'started', color: '#0f783c' };
const CANCELED = { id: 'state-canceled', name: 'Canceled', type: 'canceled', color: '#95a2b3' };

let dir: string;
let clock: number;
let store: ItemStore;
let updates: Updates;
let accounts: WatchedAccount[];

const noKey: ModelProviderAdapter = {
  send: () => Promise.reject(new ModelError('no-key', 'No API key is saved for Z.ai.')),
  stream: () => Promise.reject(new Error('not used')),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-ares-linear-'));
  clock = new Date(2026, 9, 8, 10, 0).getTime();
  accounts = [];
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  const gate = openGate({ itemStore: store, onChange: () => updates?.sweep() });
  updates = setUpUpdates({
    itemStore: store,
    gate,
    client: createModelClient({
      settings: () => store.models.settings(),
      providers: { zai: noKey },
      ledger: store.models,
      now: () => clock,
    }),
    now: () => clock,
    accounts: () => accounts,
    log: () => {},
  });
});

afterEach(() => {
  updates.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function issue(n: number, detail: Partial<LinearIssueDetail> = {}, title = `Issue ${n}`): SourceItem {
  const identifier = `ENG-${n}`;
  const done = detail.state?.type === 'completed' || detail.state?.type === 'canceled';
  return {
    externalId: `issue-${n}`,
    kind: 'linear-issue',
    title,
    status: done ? 'done' : 'open',
    detail: {
      kind: 'linear-issue',
      identifier,
      url: `https://linear.app/acme/issue/${identifier}`,
      team: ENG,
      state: TODO,
      priority: 0,
      assignee: me,
      creator: priya,
      labels: [],
      cycle: null,
      linearProject: null,
      dueDate: null,
      estimate: null,
      description: null,
      comments: [],
      createdAt: clock - 10 * DAY,
      updatedAt: clock,
      startedAt: null,
      completedAt: null,
      canceledAt: null,
      ...detail,
    },
  };
}

// A sync saving these issues, as the sync engine saves a page.
function sync(...items: SourceItem[]) {
  store.saveFromSource({ source: 'linear', account: ACME, items, deleted: [], me: me.id });
  updates.sweep();
}

const idOf = (n: number) =>
  store
    .query({ kinds: ['linear-issue'], source: 'linear', account: ACME, includeDeleted: true })
    .find((item) => item.externalId === `issue-${n}`)?.id as string;
const linearTodos = () => store.query({ kinds: ['todo'] }).map((todo) => todo.title);
const queued = () => updates.queue.list();
const texts = async () => (await updates.give())?.lines.map((line) => line.text) ?? [];

describe('Linear issues taken off the User’s list', () => {
  it('a reassignment detected by sync is one For your information line that opens the issue', async () => {
    sync(issue(418, {}, 'Fix the export'));
    expect(linearTodos()).toEqual(['Fix the export']);
    expect(queued()).toEqual([]);

    clock += MINUTE;
    sync(issue(418, { assignee: priya, updatedAt: clock }, 'Fix the export'));
    expect(linearTodos()).toEqual([]);
    const [line] = queued();
    expect(queued()).toHaveLength(1);
    expect(line).toMatchObject({
      group: 'fyi',
      section: 'linear',
      itemIds: [idOf(418)],
      about: {
        kind: 'linear-left',
        issues: [{ itemId: idOf(418), identifier: 'ENG-418', why: 'ENG-418 was reassigned to Priya Patel' }],
      },
    });
    expect(await texts()).toEqual(['ENG-418 was reassigned to Priya Patel.']);
  });

  it('several merge into one line, across syncs, until the User acts on it', async () => {
    sync(issue(1), issue(2), issue(3), issue(4));
    clock += MINUTE;
    sync(issue(1, { assignee: priya, updatedAt: clock }), issue(2, { assignee: dana, updatedAt: clock }));
    clock += MINUTE;
    sync(issue(3, { assignee: priya, updatedAt: clock }));

    expect(queued()).toHaveLength(1);
    const [line] = queued();
    expect(line?.itemIds).toEqual([idOf(1), idOf(2), idOf(3)]);
    expect(await texts()).toEqual(['3 of your Linear issues were reassigned.']);

    // Looked at again: nothing is queued twice.
    updates.sweep();
    expect(queued()).toHaveLength(1);
    expect(line?.about.kind === 'linear-left' && line.about.issues).toHaveLength(3);

    // Done: the next one starts a line of its own, and the earlier ones never come back.
    updates.act(line?.id as number, 'done');
    updates.sweep();
    expect(queued()).toEqual([]);
    clock += MINUTE;
    sync(issue(4, { state: CANCELED, updatedAt: clock }));
    expect(queued()).toHaveLength(1);
    expect(queued()[0]?.itemIds).toEqual([idOf(4)]);
    expect(await texts()).toEqual(['ENG-4 was cancelled.']);
  });

  it('a mix of reasons says they left the list', async () => {
    sync(issue(1), issue(2));
    clock += MINUTE;
    sync(issue(1, { assignee: priya, updatedAt: clock }), issue(2, { state: CANCELED, updatedAt: clock }));
    expect(await texts()).toEqual(['2 of your Linear issues left your list.']);
  });

  it('not when the User reassigned it themselves in Commander', () => {
    sync(issue(7));
    store.record({ type: 'edit-fields', itemId: idOf(7), fields: { assignee: priya } }, {
      by: { kind: 'user' },
    } satisfies ActionContext);
    expect(linearTodos()).toEqual([]);
    updates.sweep();
    expect(queued()).toEqual([]);
  });

  it('an issue assigned back before the User asked leaves the line, and an empty line is resolved', () => {
    sync(issue(1), issue(2));
    clock += MINUTE;
    sync(issue(1, { assignee: priya, updatedAt: clock }), issue(2, { assignee: priya, updatedAt: clock }));
    expect(queued()[0]?.itemIds).toEqual([idOf(1), idOf(2)]);

    clock += MINUTE;
    sync(issue(1, { assignee: me, updatedAt: clock }));
    expect(queued()[0]?.itemIds).toEqual([idOf(2)]);
    clock += MINUTE;
    sync(issue(2, { assignee: me, updatedAt: clock }));
    expect(queued()).toEqual([]);
    expect(store.updates.lastWithKey('linear-left')?.status).toBe('resolved');
  });

  it('only looks back a week the first time, so an old history doesn’t flood the queue', () => {
    sync(issue(1));
    clock += MINUTE;
    // Before any line was queued (Commander before this feature): reassigned 8 days ago.
    store.saveFromSource({
      source: 'linear',
      account: ACME,
      items: [issue(1, { assignee: priya, updatedAt: clock })],
      deleted: [],
      me: me.id,
    });
    clock += 8 * DAY;
    updates.sweep();
    expect(queued()).toEqual([]);
  });
});

describe('an Account that needs reconnecting', () => {
  const acme = (needsReconnect: boolean): WatchedAccount => ({
    account: ACME,
    sources: ['linear'],
    name: 'Acme',
    needsReconnect,
  });

  it('queues one line that clears itself once reconnected', async () => {
    accounts = [acme(false)];
    updates.sweep();
    expect(queued()).toEqual([]);

    accounts = [acme(true)];
    updates.sweep();
    updates.sweep();
    expect(queued()).toHaveLength(1);
    expect(queued()[0]).toMatchObject({
      group: 'now',
      section: 'linear',
      itemIds: [],
      about: { kind: 'reconnect', account: ACME, sourceName: 'Linear', name: 'Acme' },
    });
    expect(await texts()).toEqual(['Linear (Acme) needs you to sign in again; syncing is paused.']);

    accounts = [acme(false)];
    updates.sweep();
    expect(queued()).toEqual([]);
    expect(store.updates.lastWithKey(`reconnect:${ACME}`)?.status).toBe('resolved');
  });

  it('dismissed, it stays dismissed until the Account is reconnected and needs it again', () => {
    accounts = [acme(true)];
    updates.sweep();
    updates.act(queued()[0]?.id as number, 'dismiss');
    updates.sweep();
    expect(queued()).toEqual([]);

    accounts = [acme(false)];
    updates.sweep();
    accounts = [acme(true)];
    updates.sweep();
    expect(queued()).toHaveLength(1);
  });

  it('an Account removed takes its line with it; one with no name still says which Source', async () => {
    accounts = [
      {
        account: 'google:sam@example.com',
        sources: ['gmail', 'google-calendar'],
        name: null,
        needsReconnect: true,
      },
    ];
    updates.sweep();
    expect(queued()[0]?.section).toBe('email');
    expect(await texts()).toEqual(['Your Google Account needs you to sign in again; syncing is paused.']);
    accounts = [];
    updates.sweep();
    expect(queued()).toEqual([]);
  });
});

describe('stuck Linear issues', () => {
  // A stuck line as the job queues it.
  function stuckLine(...ns: number[]): Enqueue {
    return {
      group: 'fyi',
      mergeKey: `linear-stuck:${ENG.id}`,
      about: {
        kind: 'linear-stuck',
        team: ENG,
        issues: ns.map((n) => {
          const item = store.get(idOf(n))?.item;
          const detail = item?.detail as LinearIssueDetail;
          return {
            itemId: idOf(n),
            identifier: detail.identifier,
            reason: `${detail.identifier} has sat in review for 4 days; Priya hasn’t looked at it yet.`,
            changedAt: lastChangedAt(detail),
          };
        }),
      },
      itemIds: ns.map(idOf),
      section: 'linear',
    };
  }

  it('the line merges by team, and an issue leaves it once it changes; the last one expires it', async () => {
    const stale = { state: REVIEW, updatedAt: clock - 4 * DAY };
    sync(issue(402, stale, 'Rate limiter'), issue(403, stale, 'Retry queue'));
    updates.queue.enqueue(stuckLine(402));
    updates.queue.enqueue(stuckLine(403));
    expect(queued()).toHaveLength(1);
    expect(await texts()).toEqual(['2 of your Engineering issues look stuck.']);

    // A new comment on ENG-402 is a change: it leaves the line.
    clock += MINUTE;
    const comment = { id: 'c1', author: priya, body: 'Looking now', createdAt: clock, updatedAt: clock };
    sync(issue(402, { ...stale, comments: [comment] }, 'Rate limiter'));
    expect(queued()[0]?.itemIds).toEqual([idOf(403)]);
    expect(await texts()).toEqual(['ENG-403 has sat in review for 4 days; Priya hasn’t looked at it yet.']);

    clock += MINUTE;
    sync(issue(403, { state: REVIEW, updatedAt: clock }, 'Retry queue'));
    expect(queued()).toEqual([]);
    expect(store.updates.lastWithKey(`linear-stuck:${ENG.id}`)?.status).toBe('expired');
  });
});
