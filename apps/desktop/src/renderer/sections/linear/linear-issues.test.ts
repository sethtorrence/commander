import type { ItemStore } from '@commander/core/src/item-store';
import type { Project } from '@commander/domain';
import type { AccountSummary, AccountSyncStatus } from '@commander/domain/ipc';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestItemStore } from '../../item-store/test-item-store';
import { projectsIn } from '../../projects/projects';
import { describeIssueEntry, type LinearIssues, linearIssuesIn, syncLine } from './linear-issues';
import { ACME, issue, STATES } from './test-issues';

// The Linear Section's view of the Item store, against a real one on a temporary database, with
// issues arriving the way Linear sync saves them (saveFromSource).
let store: ItemStore;
let issues: LinearIssues;
let close: () => void;
let file: ReturnType<typeof projectsIn>['file'];

beforeEach(() => {
  const opened = openTestItemStore();
  ({ store, close } = opened);
  issues = linearIssuesIn(opened.client);
  file = projectsIn(opened.client).file;
});

afterEach(() => close());

const save = (...items: ReturnType<typeof issue>[]) =>
  store.saveFromSource({ source: 'linear', account: ACME, items });

describe('reading Linear issues', () => {
  it('lists every Linear issue Commander holds, open and closed, and nothing else', async () => {
    save(
      issue({ identifier: 'ENG-1', title: 'Fix the login loop' }),
      issue({ identifier: 'ENG-2', title: 'Rotate the keys', state: STATES.done }),
    );
    store.record({ type: 'create', item: { kind: 'todo', title: 'Not an issue' } }, { by: { kind: 'user' } });

    const listed = await issues.list();

    expect(listed.map((item) => [item.title, item.status]).sort()).toEqual([
      ['Fix the login loop', 'open'],
      ['Rotate the keys', 'done'],
    ]);
  });

  it('leaves out issues deleted in Linear', async () => {
    save(issue({ identifier: 'ENG-1' }));
    store.saveFromSource({ source: 'linear', account: ACME, deleted: ['issue-ENG-1'] });

    expect(await issues.list()).toEqual([]);
  });

  it('gives an issue’s Links both ways and its history, where filing by the User shows and undoes', async () => {
    save(issue({ identifier: 'ENG-1' }));
    const [item] = await issues.list();
    if (!item) throw new Error('no issue');
    const lt = store.changeProject({
      type: 'create',
      project: { name: 'Longtail', code: 'LT', accent: 'blue' },
    }).project as Project;
    const todo = store.record(
      { type: 'create', item: { kind: 'todo', title: 'Follow up on ENG-1' } },
      { by: { kind: 'user' } },
    );
    store.record(
      { type: 'link', from: todo.itemId, linkType: 'refers-to', to: item.id },
      { by: { kind: 'user' } },
    );

    const filed = await file(item.id, lt.id);
    const history = await issues.history(item.id);

    expect(await issues.links(item.id)).toMatchObject([
      { type: 'refers-to', backlink: true, other: { id: todo.itemId, title: 'Follow up on ENG-1' } },
    ]);
    expect(history.map((entry) => describeIssueEntry(entry, history, [lt]))).toEqual([
      'Filed under LT by you',
      'Linked by you',
      'Added from Linear',
    ]);

    await issues.undo(filed.id);
    const after = await issues.history(item.id);
    expect(store.get(item.id)?.item.filing).toBeNull();
    expect(describeIssueEntry(after[0] as (typeof after)[0], after, [lt])).toBe('Filing undone by you');
  });

  it('words what Linear changed: closed, reopened, renamed, deleted', async () => {
    save(issue({ identifier: 'ENG-1', title: 'Old' }));
    save(issue({ identifier: 'ENG-1', title: 'Old', state: STATES.done }));
    save(issue({ identifier: 'ENG-1', title: 'Old', state: STATES.todo }));
    save(issue({ identifier: 'ENG-1', title: 'New' }));
    save(issue({ identifier: 'ENG-1', title: 'New', state: STATES.progress }));
    const [item] = store.query({ kinds: ['linear-issue'] });
    store.saveFromSource({ source: 'linear', account: ACME, deleted: ['issue-ENG-1'] });
    const history = await issues.history(item?.id ?? '');

    expect(history.map((entry) => describeIssueEntry(entry, history))).toEqual([
      'Deleted in Linear',
      'Changed in Linear',
      'Renamed in Linear',
      'Reopened in Linear',
      'Closed in Linear',
      'Added from Linear',
    ]);
  });
});

describe('the sync status line', () => {
  const now = new Date(2026, 9, 3, 15, 0);
  const status = (overrides: Partial<AccountSyncStatus> = {}): AccountSyncStatus => ({
    account: ACME,
    source: 'linear',
    activity: 'idle',
    cadenceMinutes: 15,
    cadenceChoices: [15, 30, 60],
    lastSyncedAt: new Date(2026, 9, 3, 14, 2).getTime(),
    nextSyncAt: null,
    itemCount: 4,
    problem: null,
    ...overrides,
  });
  const account = (name: string, sync: AccountSyncStatus | null): AccountSummary => ({
    id: `linear:${name.toLowerCase()}`,
    source: 'linear',
    name,
    urlKey: name.toLowerCase(),
    method: 'api-key',
    status: 'connected',
    user: null,
    sync,
  });

  it('says when the Account last synced, or that it is syncing now', () => {
    expect(syncLine([account('Acme', status())], now)).toEqual({ text: 'Synced 14:02', problem: false });
    expect(syncLine([account('Acme', status({ activity: 'syncing' }))], now)).toEqual({
      text: 'Syncing…',
      problem: false,
    });
    expect(syncLine([account('Acme', status({ lastSyncedAt: null }))], now).text).toBe('Not synced yet');
  });

  it('shows the sync engine’s problem in its own words', () => {
    const problem = { kind: 'failed' as const, message: 'Commander couldn’t reach Linear.' };
    expect(syncLine([account('Acme', status({ problem, activity: 'backing-off' }))], now)).toEqual({
      text: 'Commander couldn’t reach Linear.',
      problem: true,
    });
  });

  it('names each workspace when there are several', () => {
    const problem = { kind: 'refused' as const, message: 'This Account needs reconnecting.' };
    expect(
      syncLine(
        [account('Acme', status()), account('Globex', status({ problem, activity: 'needs-reconnect' }))],
        now,
      ),
    ).toEqual({ text: 'Acme synced 14:02 · Globex: This Account needs reconnecting.', problem: true });
  });

  it('says so when no Linear Account is connected', () => {
    expect(syncLine([], now)).toEqual({ text: 'No Linear Account connected', problem: false });
  });
});
