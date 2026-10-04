import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ActionContext,
  LinearIssueDetail,
  Project,
  RuleAction,
  RuleCondition,
  RuleDraft,
  RuleGroup,
  RuleWhen,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Rules through the Item store's interface, on a real database, with Linear issues arriving through
// saveFromSource as Linear sync saves them: the first matching Rule from the top files each Item that
// the User didn't file by hand.
const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const user: ActionContext = { by: { kind: 'user' } };
const ACCOUNT = 'linear:org-acme';

let dir: string;
let clock: number;
let store: ItemStore;
let lt: Project;
let tl: Project;
let tx: Project;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-rules-'));
  clock = Date.UTC(2026, 9, 1, 12);
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
  lt = project('Longtail', 'LT');
  tl = project('Titanlink', 'TL');
  tx = project('Tactics', 'TX');
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function project(name: string, code: string): Project {
  return store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project as Project;
}

const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' };
const OPS = { id: 'team-ops', key: 'OPS', name: 'Operations' };
const INFRA = { id: 'label-infra', name: 'infra', color: '#000000' };
const PERF = { id: 'label-perf', name: 'perf', color: '#000000' };
const BUG = { id: 'label-bug', name: 'Bug', color: '#000000' };

type IssueInput = {
  id: string;
  title?: string;
  team?: typeof ENG;
  labels?: (typeof INFRA)[];
};

function detailOf({ id, team = ENG, labels = [] }: IssueInput): LinearIssueDetail {
  return {
    kind: 'linear-issue',
    identifier: `${team.key}-${id}`,
    url: `https://linear.app/acme/issue/${team.key}-${id}`,
    team,
    state: { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
    priority: 0,
    assignee: null,
    creator: null,
    labels,
    cycle: null,
    linearProject: null,
    dueDate: null,
    estimate: null,
    description: null,
    comments: [],
    createdAt: Date.UTC(2026, 8, 1),
    updatedAt: Date.UTC(2026, 8, 1),
    startedAt: null,
    completedAt: null,
    canceledAt: null,
  };
}

// Saves Linear issues as Linear sync does, and returns their Item ids by issue id.
function sync(...issues: IssueInput[]): Record<string, string> {
  clock += 1000;
  store.saveFromSource({
    source: 'linear',
    account: ACCOUNT,
    items: issues.map((issue) => ({
      externalId: issue.id,
      kind: 'linear-issue',
      title: issue.title ?? `Issue ${issue.id}`,
      detail: detailOf(issue),
    })),
  });
  const ids: Record<string, string> = {};
  for (const item of store.query({ kinds: ['linear-issue'], includeDeleted: true })) {
    if (item.externalId) ids[item.externalId] = item.id;
  }
  return ids;
}

const team = (t: typeof ENG): RuleCondition => ({
  field: 'linear.team',
  op: 'is',
  value: t.id,
  label: t.key,
});
const label = (l: typeof INFRA): RuleCondition => ({
  field: 'linear.label',
  op: 'is',
  value: l.id,
  label: l.name,
});
const titleContains = (text: string): RuleCondition => ({
  field: 'linear.title',
  op: 'contains',
  value: text,
  label: text,
});
const all = (...terms: RuleWhen['terms']): RuleWhen => ({ join: 'and', terms });
const any = (...terms: RuleWhen['terms']): RuleWhen => ({ join: 'or', terms });
const either = (...conditions: RuleCondition[]): RuleGroup => ({ join: 'or', conditions });
const draft = (into: Project, when: RuleWhen): RuleDraft => ({
  target: { kind: 'project', projectId: into.id },
  when,
});

function change(action: RuleAction) {
  clock += 1000;
  return store.changeRule(action);
}

function addRule(into: Project, when: RuleWhen, position?: number) {
  const made = change({ type: 'create', rule: draft(into, when), position }).rule;
  if (!made) throw new Error('No Rule made');
  return made;
}

const filingOf = (itemId: string | undefined) => store.get(itemId ?? '')?.item.filing ?? null;

function fileByHand(itemId: string | undefined, into: Project) {
  clock += 1000;
  store.record(
    { type: 'update', itemId: itemId ?? '', changes: { filing: { projectId: into.id, filedBy: 'user' } } },
    user,
  );
}

describe('applying Rules to Items saved from a Source', () => {
  it('files a new issue by the matching Rule, logging the Rule as the actor', () => {
    const rule = addRule(tl, all(team(ENG)));

    const ids = sync({ id: '1' });

    expect(filingOf(ids['1'])).toEqual({ projectId: tl.id, filedBy: 'rule' });
    expect(store.activity({ itemId: ids['1'] })[0]).toMatchObject({
      by: { kind: 'rule', ruleId: rule.id },
      action: 'update',
      why: 'Rule: team is ENG',
      changes: [{ field: 'filing', before: null, after: { projectId: tl.id, filedBy: 'rule' } }],
    });
  });

  it('lets the first matching Rule from the top win', () => {
    addRule(tl, all(team(ENG)));
    addRule(tx, all(label(INFRA)));
    addRule(lt, all(label(INFRA)), 0);

    const ids = sync({ id: '1', labels: [INFRA] }, { id: '2' }, { id: '3', team: OPS, labels: [INFRA] });

    expect(filingOf(ids['1'])?.projectId).toBe(lt.id);
    expect(filingOf(ids['2'])?.projectId).toBe(tl.id);
    expect(filingOf(ids['3'])?.projectId).toBe(lt.id);
  });

  it('combines conditions with AND, OR and one level of grouping', () => {
    addRule(tl, all(team(ENG), either(label(INFRA), label(PERF))));
    addRule(tx, any(team(OPS), titleContains('LOGIN')));

    const ids = sync(
      { id: 'eng-infra', labels: [INFRA] },
      { id: 'eng-perf', labels: [BUG, PERF] },
      { id: 'eng-bug', labels: [BUG] },
      { id: 'ops', team: OPS },
      { id: 'login', title: 'Fix the login loop', labels: [BUG] },
    );

    expect(filingOf(ids['eng-infra'])?.projectId).toBe(tl.id);
    expect(filingOf(ids['eng-perf'])?.projectId).toBe(tl.id);
    expect(filingOf(ids['eng-bug'])).toBeNull();
    expect(filingOf(ids.ops)?.projectId).toBe(tx.id);
    expect(filingOf(ids.login)?.projectId).toBe(tx.id);
  });

  it('never touches an Item the User filed by hand', () => {
    const ids = sync({ id: '1', team: OPS });
    fileByHand(ids['1'], lt);
    addRule(tl, all(team(ENG)));

    sync({ id: '1', team: ENG, title: 'Moved to ENG' });

    expect(filingOf(ids['1'])).toEqual({ projectId: lt.id, filedBy: 'user' });
  });

  it('overrides a filing by Ares, and one inherited from another Item', () => {
    const ids = sync({ id: '1', team: OPS }, { id: '2', team: OPS });
    store.record(
      { type: 'update', itemId: ids['1'] ?? '', changes: { filing: { projectId: lt.id, filedBy: 'ares' } } },
      { by: { kind: 'ares' } },
    );
    store.record(
      {
        type: 'update',
        itemId: ids['2'] ?? '',
        changes: { filing: { projectId: lt.id, filedBy: 'inherited' } },
      },
      user,
    );
    addRule(tl, all(team(ENG)));

    sync({ id: '1', team: ENG }, { id: '2', team: ENG });

    expect(filingOf(ids['1'])).toEqual({ projectId: tl.id, filedBy: 'rule' });
    expect(filingOf(ids['2'])).toEqual({ projectId: tl.id, filedBy: 'rule' });
  });

  it('leaves the filing alone when no Rule matches', () => {
    addRule(tl, all(team(ENG)));
    const ids = sync({ id: '1' }, { id: '2', team: OPS });
    expect(filingOf(ids['2'])).toBeNull();

    // Moved out of ENG in Linear: no Rule matches any more, so it stays where the Rule put it.
    sync({ id: '1', team: OPS });

    expect(filingOf(ids['1'])).toEqual({ projectId: tl.id, filedBy: 'rule' });
  });

  it('re-files a changed issue that now matches another Rule', () => {
    addRule(tl, all(team(ENG)));
    addRule(tx, all(team(OPS)));
    const ids = sync({ id: '1' });

    sync({ id: '1', team: OPS });

    expect(filingOf(ids['1'])).toEqual({ projectId: tx.id, filedBy: 'rule' });
  });

  it('records nothing more when an issue arrives unchanged, or the Rule already filed it there', () => {
    addRule(tl, all(team(ENG)));
    const ids = sync({ id: '1' });
    const entries = store.activity({ itemId: ids['1'] }).length;

    sync({ id: '1' });
    sync({ id: '1', title: 'Renamed in Linear' });

    expect(store.activity({ itemId: ids['1'] })).toHaveLength(entries + 1);
    expect(store.activity({ itemId: ids['1'] })[0]?.by.kind).toBe('source');
  });

  it('applies a Rule naming the workspace (the Account)', () => {
    addRule(tl, all({ field: 'linear.workspace', op: 'is', value: ACCOUNT, label: 'Acme' }));
    addRule(tx, all({ field: 'linear.team', op: 'is-not', value: ENG.id, label: 'ENG' }));

    const ids = sync({ id: '1', team: OPS });

    expect(filingOf(ids['1'])?.projectId).toBe(tl.id);
  });
});

describe('the list of Rules', () => {
  it('keeps the Rules in the order the User puts them in, and they persist', () => {
    const eng = addRule(tl, all(team(ENG)));
    const ops = addRule(tx, all(team(OPS)));
    const infra = addRule(lt, all(label(INFRA)), 1);
    expect(store.rules().map((r) => r.id)).toEqual([eng.id, infra.id, ops.id]);

    change({ type: 'move', ruleId: ops.id, position: 0 });
    expect(store.rules().map((r) => [r.id, r.order])).toEqual([
      [ops.id, 0],
      [eng.id, 1],
      [infra.id, 2],
    ]);

    store.close();
    store = openItemStore({
      path: join(dir, 'commander.db'),
      snapshotDir: join(dir, 'snapshots'),
      migrationsFolder,
      now: () => clock,
    });
    expect(store.rules().map((r) => r.id)).toEqual([ops.id, eng.id, infra.id]);
  });

  it('edits a Rule’s conditions and Project, keeping or changing its place', () => {
    const eng = addRule(tl, all(team(ENG)));
    const ops = addRule(tx, all(team(OPS)));

    const edited = change({ type: 'update', ruleId: eng.id, rule: draft(lt, all(label(PERF))) }).rule;
    expect(edited).toMatchObject({
      id: eng.id,
      order: 0,
      target: { projectId: lt.id },
      when: all(label(PERF)),
    });

    change({ type: 'update', ruleId: eng.id, rule: draft(lt, all(label(PERF))), position: 1 });
    expect(store.rules().map((r) => r.id)).toEqual([ops.id, eng.id]);
  });

  it('deletes a Rule, leaving the Items it filed where they are, and restores it to its place', () => {
    const eng = addRule(tl, all(team(ENG)));
    const ops = addRule(tx, all(team(OPS)));
    const ids = sync({ id: '1' });

    const deleted = change({ type: 'delete', ruleId: eng.id });

    expect(deleted).toEqual({ rule: null, refile: [], resort: [] });
    expect(store.rules().map((r) => r.id)).toEqual([ops.id]);
    expect(filingOf(ids['1'])).toEqual({ projectId: tl.id, filedBy: 'rule' });

    change({ type: 'restore', ruleId: eng.id });
    expect(store.rules().map((r) => r.id)).toEqual([eng.id, ops.id]);
  });

  it('refuses a Rule for a Project that doesn’t exist, or a condition on an unknown field', () => {
    expect(() =>
      change({
        type: 'create',
        rule: { target: { kind: 'project', projectId: 'nope' }, when: all(team(ENG)) },
      }),
    ).toThrow(/No Project/);
    expect(() =>
      change({
        type: 'create',
        rule: draft(tl, all({ field: 'linear.mood', op: 'is', value: 'happy', label: 'happy' })),
      }),
    ).toThrow(/field/);
    expect(() =>
      change({ type: 'create', rule: draft(tl, all({ ...titleContains('x'), field: 'linear.team' })) }),
    ).toThrow(/contains/);
    expect(store.rules()).toEqual([]);
  });
});

describe('previewing a Rule in the editor', () => {
  it('counts and samples the Items it matches, and names the Rules it overlaps', () => {
    const eng = addRule(tl, all(team(ENG)));
    addRule(tx, all(team(OPS)));
    sync({ id: '1', labels: [INFRA] }, { id: '2', team: OPS }, { id: '3', labels: [INFRA] }, { id: '4' });

    const preview = store.previewRule({ rule: draft(lt, all(label(INFRA))), sampleSize: 1 });

    expect(preview.count).toBe(2);
    expect(preview.sample).toHaveLength(1);
    expect(preview.overlaps.map((r) => r.id)).toEqual([eng.id]);
  });

  it('leaves the Rule being edited out of its own overlaps', () => {
    const eng = addRule(tl, all(team(ENG)));
    sync({ id: '1' });

    expect(store.previewRule({ rule: draft(lt, all(team(ENG))), ruleId: eng.id }).overlaps).toEqual([]);
    expect(store.previewRule({ rule: draft(lt, all(team(OPS))) })).toMatchObject({ count: 0, overlaps: [] });
  });
});

describe('re-filing existing Items after a Rule changes', () => {
  it('offers the Items a new Rule would move, with where they are and where they would go', () => {
    const ids = sync({ id: '1' }, { id: '2' }, { id: '3', team: OPS }, { id: '4' });
    fileByHand(ids['2'], lt);
    store.record(
      { type: 'update', itemId: ids['4'] ?? '', changes: { filing: { projectId: tl.id, filedBy: 'ares' } } },
      { by: { kind: 'ares' } },
    );

    const made = change({ type: 'create', rule: draft(tl, all(team(ENG))) });

    // Item 2 was filed by hand and item 4 is already under TL: neither is offered.
    expect(made.refile).toEqual([
      {
        item: expect.objectContaining({ id: ids['1'] }),
        from: null,
        to: { projectId: tl.id, filedBy: 'rule' },
        ruleId: made.rule?.id,
      },
    ]);
    // Nothing moves until the User accepts.
    expect(filingOf(ids['1'])).toBeNull();
  });

  it('offers the Items an edit or a reorder moves', () => {
    const eng = addRule(tl, all(team(ENG)));
    const infra = addRule(tx, all(label(INFRA)));
    const ids = sync({ id: '1', labels: [INFRA] }, { id: '2', team: OPS, labels: [INFRA] }, { id: '3' });

    const moved = change({ type: 'move', ruleId: infra.id, position: 0 });
    expect(moved.refile.map((c) => [c.item.id, c.to.projectId])).toEqual([[ids['1'], tx.id]]);

    const edited = change({ type: 'update', ruleId: eng.id, rule: draft(lt, all(team(ENG))) });
    expect(edited.refile.map((c) => [c.item.id, c.from?.projectId, c.to.projectId])).toEqual([
      [ids['3'], tl.id, lt.id],
    ]);
  });

  it('re-files the accepted Items as one change, logged with the Rule as the actor, and one undo reverts all', () => {
    const ids = sync({ id: '1' }, { id: '2' }, { id: '3' });
    const made = change({ type: 'create', rule: draft(tl, all(team(ENG))) });
    clock += 1000;

    const entries = store.refile(made.refile.map((c) => c.item.id));

    expect(entries).toHaveLength(3);
    for (const id of [ids['1'], ids['2'], ids['3']]) {
      expect(filingOf(id)).toEqual({ projectId: tl.id, filedBy: 'rule' });
      expect(store.activity({ itemId: id })[0]).toMatchObject({
        by: { kind: 'rule', ruleId: made.rule?.id },
        why: 'Rule: team is ENG',
      });
    }

    clock += 1000;
    const undone = store.undoRefile(entries.map((e) => e.id));

    expect(undone).toHaveLength(3);
    for (const id of [ids['1'], ids['2'], ids['3']]) expect(filingOf(id)).toBeNull();
    expect(store.activity({ itemId: ids['1'] })[0]).toMatchObject({ action: 'undo', by: { kind: 'user' } });
  });

  it('skips an Item filed by hand since the offer, and one the User moved before the undo', () => {
    const ids = sync({ id: '1' }, { id: '2' });
    const made = change({ type: 'create', rule: draft(tl, all(team(ENG))) });
    fileByHand(ids['1'], lt);

    const entries = store.refile(made.refile.map((c) => c.item.id));
    expect(entries.map((e) => e.itemId)).toEqual([ids['2']]);
    expect(filingOf(ids['1'])).toEqual({ projectId: lt.id, filedBy: 'user' });

    fileByHand(ids['2'], tx);
    expect(store.undoRefile(entries.map((e) => e.id))).toEqual([]);
    expect(filingOf(ids['2'])).toEqual({ projectId: tx.id, filedBy: 'user' });
  });
});

describe('undoing a re-filing', () => {
  it('undoes only what Rules filed', () => {
    const ids = sync({ id: '1' });
    fileByHand(ids['1'], lt);
    const [byHand] = store.activity({ itemId: ids['1'] });

    expect(store.undoRefile([byHand?.id ?? 0])).toEqual([]);
    expect(filingOf(ids['1'])).toEqual({ projectId: lt.id, filedBy: 'user' });
  });
});

const projectOf = (rule: { target: RuleDraft['target'] }) =>
  rule.target.kind === 'project' ? rule.target.projectId : null;

describe('merging Projects', () => {
  it('moves the merged Project’s Rules to the one kept, and undo puts them back', () => {
    const toTx = addRule(tx, all(team(OPS)));
    const toTl = addRule(tl, all(team(ENG)));

    const merged = store.changeProject({ type: 'merge', projectId: tx.id, into: tl.id });
    expect(store.rules().map((r) => [r.id, projectOf(r)])).toEqual([
      [toTx.id, tl.id],
      [toTl.id, tl.id],
    ]);

    const undone = store.changeProject({ type: 'undo', changeId: merged.id });
    expect(store.rules().map((r) => [r.id, projectOf(r)])).toEqual([
      [toTx.id, tx.id],
      [toTl.id, tl.id],
    ]);

    // Undoing the undo merges them again, Rules included.
    store.changeProject({ type: 'undo', changeId: undone.id });
    expect(store.rules().map((r) => projectOf(r))).toEqual([tl.id, tl.id]);
  });
});
