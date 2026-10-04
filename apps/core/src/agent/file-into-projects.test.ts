import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActionContext,
  FILE_INTO_PROJECTS,
  type LinearIssueDetail,
  type Project,
} from '@commander/domain';
import { createModelClient, type ModelProviderAdapter, type ProviderRequest } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { fileIntoProjectsJob, staleFilingSuggestions } from './file-into-projects';
import { createJobRunner, type JobRunner } from './runner';

// "File into Projects" end to end through the runner, on Linear issue fixtures saved as Linear sync
// saves them, in a real Item store, with the gate deciding. The model is a fake provider answering
// with recorded-style replies (GLM-5.3-Flash in JSON mode), keyed by the issue each prompt is about.

const user: ActionContext = { by: { kind: 'user' } };
const ACCOUNT = 'linear:org-acme';
const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' };
const OPS = { id: 'team-ops', key: 'OPS', name: 'Operations' };

let dir: string;
let clock: number;
let store: ItemStore;
let gate: Gate;
let runner: JobRunner;
let calls: ProviderRequest[];
// What the fake model answers for each issue, by identifier.
let replies: Record<string, { projectCode: string; confidence: number; reason?: string }>;
let lt: Project;
let tl: Project;
let tx: Project;

const provider: ModelProviderAdapter = {
  async send(request) {
    calls.push(request);
    const content = request.messages.at(-1)?.content ?? '';
    const [, ref, identifier] = /label="(I\d+) · Linear issue ([A-Z]+-\d+)"/.exec(content) ?? [];
    const reply = identifier ? replies[identifier] : undefined;
    const filings = reply && ref ? [{ itemId: ref, ...reply }] : [];
    return {
      text: JSON.stringify({ filings, steering: [] }),
      usage: { inputTokens: 700, cachedTokens: 0, outputTokens: 40 },
    };
  },
  stream: () => Promise.reject(new Error('not used')),
};

function project(name: string, code: string): Project {
  return store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project as Project;
}

type IssueInput = { id: string; title: string; team?: typeof ENG; description?: string };

function detailOf({ id, team = OPS, description }: IssueInput): LinearIssueDetail {
  return {
    kind: 'linear-issue',
    identifier: `${team.key}-${id}`,
    url: `https://linear.app/acme/issue/${team.key}-${id}`,
    team,
    state: { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
    priority: 0,
    assignee: null,
    creator: null,
    labels: [{ id: 'label-infra', name: 'infra', color: '#000000' }],
    cycle: null,
    linearProject: { id: 'lp-relay', name: 'Relay' },
    dueDate: null,
    estimate: null,
    description: description ?? null,
    comments: [],
    createdAt: Date.UTC(2026, 8, 1),
    updatedAt: Date.UTC(2026, 8, 1),
    startedAt: null,
    completedAt: null,
    canceledAt: null,
  };
}

// Saves Linear issues as Linear sync does, and returns their Item ids by identifier.
function sync(...issues: IssueInput[]): Record<string, string> {
  clock += 1000;
  store.saveFromSource({
    source: 'linear',
    account: ACCOUNT,
    items: issues.map((issue) => ({
      externalId: issue.id,
      kind: 'linear-issue',
      title: issue.title,
      detail: detailOf(issue),
    })),
  });
  const ids: Record<string, string> = {};
  for (const item of store.query({ kinds: ['linear-issue'] })) {
    if (item.detail?.kind === 'linear-issue') ids[item.detail.identifier] = item.id;
  }
  return ids;
}

const filingOf = (id: string) => store.get(id)?.item.filing ?? null;
const prompts = () => calls.map((call) => call.messages.at(-1)?.content ?? '');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-file-into-projects-'));
  clock = Date.UTC(2026, 9, 3, 9);
  calls = [];
  replies = {};
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  lt = project('Longtail', 'LT');
  tl = project('Titanlink', 'TL');
  tx = project('Tactics', 'TX');
  store.changeRule({
    type: 'create',
    rule: {
      target: { kind: 'project', projectId: lt.id },
      when: { join: 'and', terms: [{ field: 'linear.team', op: 'is', value: ENG.id, label: 'ENG' }] },
    },
  });
  gate = openGate({ itemStore: store });
  runner = createJobRunner({
    jobs: [fileIntoProjectsJob(store)],
    client: createModelClient({
      settings: () => store.models.settings(),
      providers: { zai: provider },
      ledger: store.models,
      now: () => clock,
    }),
    gate,
    store: store.agent,
    now: () => clock,
    log: () => {},
  });
});

afterEach(() => {
  runner.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function run(itemIds: string[] = []) {
  runner.trigger({ kind: 'items-arrived', itemIds });
  await runner.settled();
}

describe('File into Projects', () => {
  it('registers as Organise in Linear, a Quick job at low thinking, run when Items arrive', () => {
    const job = fileIntoProjectsJob(store);
    expect(job).toMatchObject({
      job: FILE_INTO_PROJECTS,
      name: 'File into Projects',
      tier: 'quick',
      reasoningEffort: 'low',
      action: { action: FILE_INTO_PROJECTS, actionKind: 'organise', section: 'linear' },
      triggers: { 'items-arrived': true },
    });
    expect(gate.actions().map((action) => action.action)).toContain(FILE_INTO_PROJECTS);
  });

  it('skips Rule-matched and hand-filed Items, and sends each other Item in a data block of its own', async () => {
    const ids = sync(
      { id: '1', title: 'Rotate the deploy keys', team: ENG },
      { id: '2', title: 'Relay latency dashboard' },
      { id: '3', title: 'Pager rota for October' },
    );
    store.record(
      {
        type: 'update',
        itemId: ids['OPS-3'] as string,
        changes: { filing: { projectId: tx.id, filedBy: 'user' } },
      },
      user,
    );
    expect(filingOf(ids['ENG-1'] as string)).toEqual({ projectId: lt.id, filedBy: 'rule' });

    await run();

    // One call, for the one Item no Rule filed and the User didn't file.
    expect(prompts()).toHaveLength(1);
    const prompt = prompts()[0] as string;
    expect(prompt).toContain('Relay latency dashboard');
    expect(prompt).not.toContain('Rotate the deploy keys');
    expect(prompt).not.toContain('Pager rota');
    // The issue is outside material, in its own block; the Projects and Rules are the User's.
    expect(prompt).toMatch(/<data-\w+ ref="U1" label="I1 · Linear issue OPS-2" source="outside">/);
    expect(prompt).toMatch(/label="Projects" source="the User">/);
    expect(prompt).toContain('TL · Titanlink');
    expect(prompt).toContain('Rule: team is ENG');
    expect(prompt).toContain('┆ Team: OPS (Operations)');
    expect(prompt).toContain('┆ Linear project: Relay');
    expect(prompt).toContain('┆ Labels: infra');
    expect(calls[0]?.reasoningEffort).toBe('low');
  });

  it('files a confident Item as Ares, with his reason, and leaves a suggestion for a less confident one', async () => {
    replies = {
      'OPS-2': { projectCode: 'TL', confidence: 0.92, reason: 'Relay is Titanlink’s project' },
      'OPS-4': { projectCode: 'tx', confidence: 0.55 },
    };
    const ids = sync({ id: '2', title: 'Relay latency dashboard' }, { id: '4', title: 'Pager rota' });

    await run();

    const sure = ids['OPS-2'] as string;
    expect(filingOf(sure)).toEqual({ projectId: tl.id, filedBy: 'ares' });
    const filed = store.activity({ itemId: sure }).find((entry) => entry.by.kind === 'ares');
    expect(filed).toMatchObject({ action: 'update', why: 'Relay is Titanlink’s project' });
    expect(filed?.changes).toEqual([
      { field: 'filing', before: null, after: { projectId: tl.id, filedBy: 'ares' } },
    ]);
    expect(store.get(sure)?.item.filingSuggestion).toBeUndefined();

    // Not sure: still Unfiled, wearing the dashed Badge (the pending suggestion).
    const unsure = ids['OPS-4'] as string;
    expect(filingOf(unsure)).toBeNull();
    const [pending] = gate.activity({ itemId: unsure, statuses: ['pending'] });
    expect(pending).toMatchObject({ action: FILE_INTO_PROJECTS, decision: 'ask', chained: false });
    expect(store.get(unsure)?.item.filingSuggestion).toEqual({ proposalId: pending?.id, projectId: tx.id });
    // A Todo behind the issue wears it too.
    store.record(
      {
        type: 'create',
        item: {
          kind: 'todo',
          title: 'Pager rota',
          detail: { kind: 'todo', origin: 'linear', dueOn: null, backedBy: unsure },
        },
      },
      user,
    );
    const todo = store.query({ kinds: ['todo'] })[0];
    expect(todo?.filingSuggestion).toEqual({ proposalId: pending?.id, projectId: tx.id });
  });

  it('validates the reply against the active codes: unknown, archived and Unfiled change nothing', async () => {
    replies = {
      'OPS-2': { projectCode: 'ZZ', confidence: 0.95 },
      'OPS-3': { projectCode: 'unfiled', confidence: 0.9 },
      'OPS-4': { projectCode: 'TX', confidence: 0.95 },
    };
    store.changeProject({ type: 'archive', projectId: tx.id });
    const ids = sync(
      { id: '2', title: 'Relay latency dashboard' },
      { id: '3', title: 'Lunch order' },
      { id: '4', title: 'Pager rota' },
    );

    await run();

    for (const id of Object.values(ids)) expect(filingOf(id)).toBeNull();
    expect(gate.activity()).toEqual([]);
    // Each was looked at as it is, so none is sent again until it changes.
    calls = [];
    await run();
    expect(calls).toHaveLength(0);
  });

  it('never proposes for an Item that has a suggestion waiting, or that a Rule matches', async () => {
    replies = { 'OPS-4': { projectCode: 'TX', confidence: 0.5 } };
    const ids = sync({ id: '4', title: 'Pager rota' });
    await run();
    expect(gate.activity({ statuses: ['pending'] })).toHaveLength(1);
    // The issue changes (a new title), but the suggestion still waits: not sent again.
    calls = [];
    sync({ id: '4', title: 'Pager rota for November' });
    await run([ids['OPS-4'] as string]);
    expect(calls).toHaveLength(0);
  });

  it('a Rule matching later replaces Ares’s filing, and settles a suggestion he left', async () => {
    replies = {
      'OPS-2': { projectCode: 'TL', confidence: 0.95 },
      'OPS-4': { projectCode: 'TX', confidence: 0.5 },
    };
    const ids = sync({ id: '2', title: 'Relay latency dashboard' }, { id: '4', title: 'Pager rota' });
    await run();
    const filed = ids['OPS-2'] as string;
    const unsure = ids['OPS-4'] as string;
    expect(filingOf(filed)?.filedBy).toBe('ares');

    // A Rule for team OPS, and the next sync of both issues.
    store.changeRule({
      type: 'create',
      rule: {
        target: { kind: 'project', projectId: lt.id },
        when: { join: 'and', terms: [{ field: 'linear.team', op: 'is', value: OPS.id, label: 'OPS' }] },
      },
    });
    sync(
      { id: '2', title: 'Relay latency dashboard', description: 'p95 over 300ms' },
      { id: '4', title: 'Pager rota', description: 'Two people a week' },
    );
    expect(filingOf(filed)).toEqual({ projectId: lt.id, filedBy: 'rule' });
    expect(filingOf(unsure)).toEqual({ projectId: lt.id, filedBy: 'rule' });

    // The suggestion left on the second is stale now, and the Agent settles it.
    const stale = staleFilingSuggestions(store);
    expect(stale).toHaveLength(1);
    for (const id of stale) gate.dismiss(id);
    expect(store.get(unsure)?.item.filingSuggestion).toBeUndefined();

    // Ares never re-files them.
    calls = [];
    await run(Object.values(ids));
    expect(calls).toHaveLength(0);
  });

  it('the gate refuses Ares’s filing over the User’s or a Rule’s', () => {
    const ids = sync(
      { id: '1', title: 'Rotate the deploy keys', team: ENG },
      { id: '3', title: 'Pager rota' },
    );
    store.record(
      {
        type: 'update',
        itemId: ids['OPS-3'] as string,
        changes: { filing: { projectId: tx.id, filedBy: 'user' } },
      },
      user,
    );
    for (const itemId of [ids['ENG-1'] as string, ids['OPS-3'] as string]) {
      expect(() =>
        gate.propose({
          actionKind: 'organise',
          action: FILE_INTO_PROJECTS,
          section: 'linear',
          itemId,
          itemActions: [
            { type: 'update', itemId, changes: { filing: { projectId: tl.id, filedBy: 'ares' } } },
          ],
          confidence: 0.99,
          reason: 'Looks like Titanlink work',
        }),
      ).toThrow(/never re-files/);
    }
  });
});
