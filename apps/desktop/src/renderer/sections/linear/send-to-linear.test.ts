import type { LinearCatalog, LinearCatalogTeam } from '@commander/domain';
import type { AccountSummary } from '@commander/domain/ipc';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestItemStore } from '../../item-store/test-item-store';
import {
  assigneeChoices,
  type Catalogs,
  draftOf,
  initialForm,
  linearSenderIn,
  sendableAccounts,
  withTeam,
} from './send-to-linear';
import { ACME, ENG, GLOBEX, OPS, PRIYA, STATES } from './test-issues';

const ME = { id: 'user-me', name: 'Sam Rivera', displayName: 'Sam Rivera', email: null };
const team = (t: typeof ENG, extra: Partial<LinearCatalogTeam> = {}): LinearCatalogTeam => ({
  ...t,
  states: Object.values(STATES),
  members: [PRIYA, { ...ME, displayName: 'sam', email: 'sam@acme.test' }],
  labels: [],
  cycles: [],
  linearProjects: [],
  ...extra,
});
const account = (id: string, name: string): AccountSummary => ({
  id,
  source: 'linear',
  name,
  urlKey: name.toLowerCase(),
  method: 'api-key',
  status: 'connected',
  user: { id: ME.id, name: ME.name },
  sync: null,
});
const accounts = [account(ACME, 'Acme'), account(GLOBEX, 'Globex')];
const catalogs: Catalogs = new Map<string, LinearCatalog | null>([
  [ACME, { kind: 'linear', teams: [team(ENG), team(OPS, { defaultStateId: STATES.backlog.id })] }],
  [GLOBEX, null],
]);

describe('the Send to Linear form', () => {
  it('starts on the prefilled team, its default state, assigned to the User, with no priority', () => {
    const form = initialForm(
      { title: 'Write the runbook', projectId: null, team: { account: ACME, teamId: OPS.id } },
      accounts,
      catalogs,
    );
    expect(form).toEqual({
      title: 'Write the runbook',
      account: ACME,
      teamId: OPS.id,
      assigneeId: ME.id,
      stateId: STATES.backlog.id,
      priority: 0,
      description: '',
    });
  });

  it('without a prefilled team, starts on the first workspace with teams, and its first team', () => {
    const form = initialForm({ title: '', projectId: null, team: null }, accounts, catalogs);
    expect(form).toMatchObject({ account: ACME, teamId: ENG.id, stateId: STATES.todo.id });
    expect(sendableAccounts(accounts, catalogs).map((each) => each.id)).toEqual([ACME]);
  });

  it('offers the User first, then the team’s other members; a new team resets the state', () => {
    const form = initialForm({ title: '', projectId: null, team: null }, accounts, catalogs);
    expect(assigneeChoices(accounts, catalogs, form).map((user) => user.id)).toEqual([ME.id, PRIYA.id]);
    expect(withTeam({ ...form, stateId: STATES.done.id }, ACME, OPS.id, accounts, catalogs).stateId).toBe(
      STATES.backlog.id,
    );
  });

  it('makes the draft from the choices, with the Todo or Block it comes from', () => {
    const form = { ...initialForm({ title: '', projectId: null, team: null }, accounts, catalogs) };
    expect(draftOf(form, {}, accounts, catalogs)).toEqual({ problem: 'An issue needs a title' });
    const filled = {
      ...form,
      title: ' Write it ',
      priority: 2,
      description: ' Steps ',
      assigneeId: PRIYA.id,
    };
    expect(draftOf(filled, { from: 'block-1' }, accounts, catalogs)).toEqual({
      draft: {
        from: 'block-1',
        account: ACME,
        team: ENG,
        title: 'Write it',
        description: 'Steps',
        assignee: PRIYA,
        state: STATES.todo,
        priority: 2,
      },
    });
    const unassigned = draftOf({ ...filled, assigneeId: null }, {}, accounts, catalogs);
    expect(unassigned).toMatchObject({ draft: { assignee: null } });
    expect(draftOf({ ...filled, teamId: null }, {}, accounts, catalogs)).toEqual({
      problem: 'Choose a team',
    });
  });
});

describe('sending through the Item store', () => {
  let test: ReturnType<typeof openTestItemStore>;
  beforeEach(() => {
    test = openTestItemStore();
    const known = catalogs.get(ACME) as LinearCatalog;
    test.store.syncState.saveCatalog(ACME, 'linear', known, 1);
  });
  afterEach(() => test.close());

  it('prefills from a Todo, sends it, and undoes the send', async () => {
    const sender = linearSenderIn(test.client);
    const todo = await test.client({
      op: 'record',
      action: {
        type: 'create',
        item: {
          kind: 'todo',
          title: 'Write the runbook',
          detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null },
        },
      },
    });
    expect(await sender.prefill({ from: todo.itemId })).toEqual({
      title: 'Write the runbook',
      projectId: null,
      team: null,
    });
    const entries = await sender.send({
      from: todo.itemId,
      account: ACME,
      team: ENG,
      title: 'Write the runbook',
      assignee: null,
      state: STATES.todo,
    });
    const issueId = entries[0]?.itemId as string;
    expect(test.store.get(issueId)?.item).toMatchObject({ kind: 'linear-issue', deletedAt: null });
    await sender.undo(entries.map((entry) => entry.id));
    expect(test.store.get(issueId)?.item.deletedAt).not.toBeNull();
    expect(test.store.get(todo.itemId)?.item).toMatchObject({ deletedAt: null, detail: { backedBy: null } });
  });
});
