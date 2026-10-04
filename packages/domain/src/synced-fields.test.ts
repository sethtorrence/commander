import { describe, expect, it } from 'vitest';
import type { LinearIssueDetail } from './linear';
import { isSyncedField, statusFromDetail, syncedFieldsOf, withSyncedFields } from './synced-fields';

const priya = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: null };
const bug = { id: 'label-bug', name: 'Bug', color: '#eb5757' };
const customer = { id: 'label-customer', name: 'Customer', color: '#5e6ad2' };
const comment = (id: string, createdAt: number) => ({
  id,
  author: priya,
  body: `Comment ${id}`,
  createdAt,
  updatedAt: createdAt,
});

const detail: LinearIssueDetail = {
  kind: 'linear-issue',
  identifier: 'ENG-418',
  url: 'https://linear.app/acme/issue/ENG-418',
  team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
  state: { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' },
  priority: 2,
  assignee: priya,
  creator: null,
  labels: [bug],
  cycle: null,
  linearProject: { id: 'lp-login', name: 'Login revamp' },
  dueDate: '2026-10-09',
  estimate: 3,
  description: 'Read-only',
  comments: [comment('c1', 10)],
  createdAt: 1,
  updatedAt: 2,
  startedAt: null,
  completedAt: null,
  canceledAt: null,
};

describe('a Linear issue’s synced fields', () => {
  it('keys every field that writes back on its own, each label and comment included', () => {
    expect(syncedFieldsOf(detail)).toEqual({
      state: detail.state,
      assignee: priya,
      priority: 2,
      dueDate: '2026-10-09',
      estimate: 3,
      cycle: null,
      linearProject: detail.linearProject,
      'label:label-bug': bug,
      'comment:c1': detail.comments[0],
    });
  });

  it('puts fields back in place, keeping labels by name and comments oldest first', () => {
    const fields = {
      ...syncedFieldsOf(detail),
      priority: 1,
      'label:label-customer': customer,
      'label:label-bug': null,
      'comment:c0': comment('c0', 5),
    };
    expect(withSyncedFields(detail, fields)).toEqual({
      ...detail,
      priority: 1,
      labels: [customer],
      comments: [comment('c0', 5), comment('c1', 10)],
    });
  });

  it('never touches what isn’t synced: the description, title and team', () => {
    const changed = withSyncedFields(detail, { ...syncedFieldsOf(detail), description: 'Hacked' });
    expect(changed.description).toBe('Read-only');
  });

  it('names which fields are synced', () => {
    expect(
      ['priority', 'label:x', 'comment:y', 'description', 'label:'].map((f) =>
        isSyncedField('linear-issue', f),
      ),
    ).toEqual([true, true, true, false, false]);
    expect(isSyncedField('todo', 'priority')).toBe(false);
  });

  it('has no synced fields for Commander’s own kinds', () => {
    expect(syncedFieldsOf({ kind: 'todo', origin: 'manual', dueOn: null, backedBy: null })).toBeNull();
    expect(syncedFieldsOf(null)).toBeNull();
  });

  it('closes the Item when the state is completed or canceled', () => {
    const done = { ...detail, state: { ...detail.state, type: 'completed' } };
    expect(statusFromDetail(done, 'open')).toBe('done');
    expect(statusFromDetail(detail, 'done')).toBe('open');
    expect(statusFromDetail(null, 'archived')).toBe('archived');
  });
});
