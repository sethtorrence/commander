import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ActionContext, LEARN_FACTS, type LinearIssueDetail, type Project } from '@commander/domain';
import { createModelClient, type ModelProviderAdapter, type ProviderRequest } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { learnFactsJob } from './learn-facts';
import { createJobRunner, type JobRunner } from './runner';

// "Learn facts" (#74) through the runner, in a real Item store, with a fake model answering with
// recorded-style replies keyed by what each prompt holds. Facts from the User's own Blocks are
// confirmed; facts from Linear issues (outside content, each in a call of its own) are not. Each is
// kept with its source, and about the People and Projects it names.

const user: ActionContext = { by: { kind: 'user' } };
const TODAY = '2026-10-04';
const OPS = { id: 'team-ops', key: 'OPS', name: 'Operations' };
const PRIYA = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: 'priya@acme.test' };

let dir: string;
let clock: number;
let store: ItemStore;
let gate: Gate;
let runner: JobRunner;
let calls: ProviderRequest[];
let logged: string[];
// What the fake model says, by a word the prompt's material holds.
let replies: { when: string; facts: unknown[] }[];
let tl: Project;
let lt: Project;

const provider: ModelProviderAdapter = {
  async send(request) {
    calls.push(request);
    const content = request.messages.at(-1)?.content ?? '';
    const facts = replies.find((reply) => content.includes(reply.when))?.facts ?? [];
    return {
      text: JSON.stringify({ facts, steering: [] }),
      usage: { inputTokens: 500, cachedTokens: 0, outputTokens: 40 },
    };
  },
  stream: () => Promise.reject(new Error('not used')),
};

function project(name: string, code: string): Project {
  return store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project as Project;
}

function issue(externalId: string, identifier: string, title: string, description: string): string {
  clock += 1000;
  const detail: LinearIssueDetail = {
    kind: 'linear-issue',
    identifier,
    url: `https://linear.app/acme/issue/${identifier}`,
    team: OPS,
    state: { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
    priority: 0,
    assignee: PRIYA,
    creator: null,
    labels: [],
    cycle: null,
    linearProject: null,
    dueDate: null,
    estimate: null,
    description,
    comments: [],
    createdAt: clock,
    updatedAt: clock,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
  };
  return store.saveFromSource({
    source: 'linear',
    account: 'linear:org-acme',
    items: [{ externalId, kind: 'linear-issue', title, detail }],
  }).created[0] as string;
}

function block(text: string, position: string): string {
  const note = store.ensureDailyNote(TODAY, user).id;
  return store.record(
    {
      type: 'create',
      item: {
        kind: 'block',
        title: text,
        detail: { kind: 'block', dailyNoteId: note, parentId: null, position, text, folded: false },
      },
    },
    user,
  ).itemId;
}

async function idle() {
  runner.trigger({ kind: 'idle' });
  await runner.settled();
}

const facts = () =>
  store.memory
    .list()
    .memories.filter((memory) => memory.kind === 'fact')
    .map((memory) => ({
      text: memory.text,
      confirmed: memory.confirmed,
      personId: memory.personId,
      projectId: memory.projectId,
      sources: memory.sources.map((source) => source.itemId),
    }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-learn-facts-'));
  clock = new Date(2026, 9, 4, 9, 30).getTime();
  calls = [];
  logged = [];
  replies = [];
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  tl = project('Titanlink', 'TL');
  lt = project('Longtail', 'LT');
  gate = openGate({ itemStore: store });
  runner = createJobRunner({
    jobs: [learnFactsJob(store, { now: () => clock })],
    client: createModelClient({
      settings: () => store.models.settings(),
      providers: { zai: provider },
      ledger: store.models,
      now: () => clock,
    }),
    gate,
    store: store.agent,
    injectionWarnings: store.injectionWarnings,
    now: () => clock,
    log: (message) => logged.push(message),
  });
});

afterEach(() => {
  runner.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Learn facts', () => {
  it('is a Quick job at low thinking, run when the machine is idle, registered as Organise', () => {
    expect(gate.actions()).toEqual([
      expect.objectContaining({ action: LEARN_FACTS, actionKind: 'organise', name: 'Learn facts' }),
    ]);
    const job = learnFactsJob(store);
    expect(job).toMatchObject({ tier: 'quick', reasoningEffort: 'low', triggers: { idle: true } });
  });

  it('keeps facts from the User’s Blocks as confirmed, and from a Linear issue as unconfirmed, each with its source', async () => {
    const relay = issue('i1', 'OPS-1', 'Relay retries', 'Priya is moving to the Titanlink reliability push.');
    const priya = store.people.list().find((person) => person.name === 'Priya Patel')?.id;
    const beta = block('Longtail’s beta launches in November', 'a0');
    block('need to send Dana the Q3 numbers', 'a1');
    replies = [
      {
        when: 'Longtail’s beta',
        facts: [{ from: 'B1', text: 'Longtail’s beta launches in November.', projectCode: 'LT' }],
      },
      {
        when: 'Relay retries',
        facts: [
          {
            from: 'I1',
            text: 'Priya Patel works on Titanlink’s reliability push',
            person: 'Priya',
            projectCode: 'tl',
          },
        ],
      },
    ];
    await idle();

    // The Blocks in one call, as the User's own words; the issue in a call of its own, as outside.
    expect(calls).toHaveLength(2);
    const [blocks, outside] = calls.map((call) => call.messages.at(-1)?.content ?? '');
    expect(blocks).toMatch(/source="the User">\n\[B1\] Longtail’s beta launches in November/);
    expect(outside).toMatch(/ref="U1" label="I1 · Linear issue OPS-1" source="outside">/);
    expect(calls[0]?.reasoningEffort).toBe('low');

    expect(facts()).toEqual(
      expect.arrayContaining([
        {
          text: 'Longtail’s beta launches in November',
          confirmed: true,
          personId: null,
          projectId: lt.id,
          sources: [beta],
        },
        {
          text: 'Priya Patel works on Titanlink’s reliability push',
          confirmed: false,
          personId: priya,
          projectId: tl.id,
          sources: [relay],
        },
      ]),
    );
    expect(facts()).toHaveLength(2);

    // Nothing changed: nothing is sent again.
    await idle();
    expect(calls).toHaveLength(2);
  });

  it('drops what it can’t use: a ref it wasn’t given, a Project that isn’t one, and facts about no one', async () => {
    block('Longtail’s beta launches in November', 'a0');
    replies = [
      {
        when: 'Longtail',
        facts: [
          { from: 'B7', text: 'Someone else’s fact', projectCode: 'LT' },
          { from: 'B1', text: 'Zed runs the Zebra project', projectCode: 'ZZ' },
          { from: 'B1', text: 'It is going to rain' },
        ],
      },
    ];
    await idle();
    expect(facts()).toEqual([]);
    expect(logged.filter((line) => line.includes('left something out'))).toHaveLength(3);
  });

  it('learns a fact once, adding each place it was seen as a source', async () => {
    const one = issue('i1', 'OPS-1', 'Relay retries', 'Relay launches in November.');
    const two = issue('i2', 'OPS-2', 'Relay backoff', 'Relay launches in November, per Priya.');
    replies = [
      { when: 'Relay', facts: [{ from: 'I1', text: 'Relay launches in November', projectCode: 'TL' }] },
    ];
    await idle();
    expect(facts()).toEqual([
      expect.objectContaining({
        text: 'Relay launches in November',
        sources: expect.arrayContaining([one, two]),
      }),
    ]);
  });
});
