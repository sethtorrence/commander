import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LinearIssueDetail, SourceBatch } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Linear issues arrive from Linear sync with their `linear-issue` detail, which the Item store keeps
// exactly as the Source sent it.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');

let dir: string;
let store: ItemStore;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-linear-issues-'));
  clock = Date.UTC(2026, 9, 1, 12);
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const priya = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: 'priya@acme.test' };

const detail: LinearIssueDetail = {
  kind: 'linear-issue',
  identifier: 'ENG-418',
  url: 'https://linear.app/acme/issue/ENG-418/fix-the-login-loop',
  team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
  state: { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' },
  priority: 2,
  assignee: priya,
  creator: { id: 'user-sam', name: 'Sam Lee', displayName: 'sam', email: null },
  labels: [{ id: 'label-bug', name: 'Bug', color: '#eb5757' }],
  cycle: {
    id: 'cycle-12',
    number: 12,
    name: null,
    startsAt: Date.UTC(2026, 8, 28),
    endsAt: Date.UTC(2026, 9, 12),
  },
  linearProject: { id: 'project-login', name: 'Login revamp' },
  dueDate: '2026-10-09',
  estimate: 3,
  description: 'The login page **loops** after SSO.',
  comments: [
    {
      id: 'comment-1',
      author: priya,
      body: 'Reproduced on staging.',
      createdAt: Date.UTC(2026, 8, 30, 9),
      updatedAt: Date.UTC(2026, 8, 30, 9),
    },
  ],
  createdAt: Date.UTC(2026, 8, 29, 10),
  updatedAt: Date.UTC(2026, 8, 30, 9),
  startedAt: Date.UTC(2026, 8, 30, 8),
  completedAt: null,
  canceledAt: null,
};

const batch = (issueDetail: LinearIssueDetail): SourceBatch => ({
  source: 'linear',
  account: 'linear:org-acme',
  items: [
    {
      externalId: 'issue-418',
      kind: 'linear-issue',
      title: 'Fix the login loop',
      people: ['linear:user-priya', 'priya@acme.test', 'linear:user-sam'],
      detail: issueDetail,
    },
  ],
});

describe('Linear issues in the Item store', () => {
  it('keeps the linear-issue detail as the Source sent it', () => {
    store.saveFromSource(batch(detail));

    expect(store.query({ kinds: ['linear-issue'] })).toMatchObject([
      { externalId: 'issue-418', title: 'Fix the login loop', detail },
    ]);
  });

  it('leaves the issue and the activity log alone when the same issue arrives again', () => {
    store.saveFromSource(batch(detail));
    const entries = store.activity().length;
    clock += 60_000;

    const again = store.saveFromSource(batch(structuredClone(detail)));

    expect(again.unchanged).toHaveLength(1);
    expect(store.activity()).toHaveLength(entries);
  });

  it('updates the detail when Linear reports a change, recording it as the Source', () => {
    const [id] = store.saveFromSource(batch(detail)).created;
    clock += 60_000;

    store.saveFromSource(batch({ ...detail, state: { ...detail.state, name: 'In Review' } }));

    expect(store.get(id ?? '')?.item.detail).toMatchObject({ state: { name: 'In Review' } });
    expect(store.activity({ itemId: id })[0]).toMatchObject({
      action: 'update',
      by: { kind: 'source', source: 'linear', account: 'linear:org-acme' },
      changes: [{ field: 'detail' }],
    });
  });

  it('refuses linear-issue detail on another kind of Item', () => {
    const wrong: SourceBatch = {
      source: 'linear',
      account: 'linear:org-acme',
      items: [{ externalId: 'x', kind: 'email', title: 'Mixed up', detail }],
    };
    expect(() => store.saveFromSource(wrong)).toThrow(/detail/);
  });
});
