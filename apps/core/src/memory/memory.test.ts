import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, LinearIssueDetail, Project } from '@commander/domain';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';

// The Memory store (#74), through the Item store that writes it: each kind of memory with its
// sources, whether it is confirmed, indexed as it is saved, and looked up by its words and by its
// fields (who and what it is about).

const user: ActionContext = { by: { kind: 'user' } };
const ACCOUNT = 'linear:org-acme';
const OPS = { id: 'team-ops', key: 'OPS', name: 'Operations' };

let dir: string;
let clock: number;
let store: ItemStore;
let tl: Project;
let tx: Project;

function open() {
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
}

function project(name: string, code: string): Project {
  return store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project as Project;
}

function issueDetail(identifier: string, assignee?: { id: string; name: string; email: string }) {
  return {
    kind: 'linear-issue',
    identifier,
    url: `https://linear.app/acme/issue/${identifier}`,
    team: OPS,
    state: { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
    priority: 0,
    assignee: assignee ? { ...assignee, displayName: assignee.name } : null,
    creator: null,
    labels: [],
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
  } as LinearIssueDetail;
}

// Saves a Linear issue as Linear sync does; returns its Item id.
function issue(
  externalId: string,
  identifier: string,
  title: string,
  assignee?: Parameters<typeof issueDetail>[1],
) {
  clock += 1000;
  store.saveFromSource({
    source: 'linear',
    account: ACCOUNT,
    items: [{ externalId, kind: 'linear-issue', title, detail: issueDetail(identifier, assignee) }],
  });
  return store.query({ kinds: ['linear-issue'], titleContains: title })[0]?.id as string;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-memory-'));
  clock = Date.UTC(2026, 9, 4, 9);
  open();
  tl = project('Titanlink', 'TL');
  tx = project('Tactics', 'TX');
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the Memory store', () => {
  it('keeps each kind with where it came from, when it was learned, and whether it is confirmed', () => {
    const relay = issue('i1', 'OPS-1', 'Relay retries');
    clock += 1000;
    const fact = store.memory.learn({
      kind: 'fact',
      text: 'Relay launches in November',
      confirmed: false,
      projectId: tl.id,
      sources: [relay],
    });
    clock += 1000;
    const example = store.memory.learn({
      kind: 'example',
      text: 'OPS-1 belongs to TX, not TL',
      confirmed: true,
      projectId: tx.id,
      sources: [relay],
    });
    clock += 1000;
    const preference = store.memory.change({ type: 'add-preference', text: 'Keep Todo titles short' }).memory;
    store.changeRule({
      type: 'create',
      rule: {
        target: { kind: 'project', projectId: tl.id },
        when: { join: 'and', terms: [{ field: 'linear.team', op: 'is', value: OPS.id, label: 'OPS' }] },
      },
    });
    const rule = store.rules()[0];

    const { memories, forReview } = store.memory.list();
    expect(forReview).toEqual([]);
    expect(memories.map((memory) => [memory.kind, memory.text, memory.confirmed, memory.by])).toEqual([
      ['preference', 'Keep Todo titles short', true, 'user'],
      ['example', 'OPS-1 belongs to TX, not TL', true, 'ares'],
      ['fact', 'Relay launches in November', false, 'ares'],
      ['rule', 'team is OPS → TL · Titanlink', true, 'user'],
    ]);
    const learned = memories.find((memory) => memory.id === fact?.id);
    expect(learned?.learnedAt).toBe(Date.UTC(2026, 9, 4, 9) + 2000);
    expect(learned?.projectId).toBe(tl.id);
    expect(learned?.sources).toEqual([
      {
        itemId: relay,
        item: { id: relay, kind: 'linear-issue', title: 'Relay retries', source: 'linear', deletedAt: null },
      },
    ]);
    expect(memories.find((memory) => memory.id === example?.id)?.sources.map((s) => s.itemId)).toEqual([
      relay,
    ]);
    expect(preference?.sources).toEqual([]);
    expect(memories.find((memory) => memory.kind === 'rule')?.ruleId).toBe(rule?.id);
  });

  it('shows Bucket Rules as rule memories too, naming the Bucket', () => {
    const receipts = store.buckets().find((bucket) => bucket.name === 'Receipts');
    store.changeRule({
      type: 'create',
      rule: {
        target: { kind: 'bucket', bucketId: receipts?.id as string },
        when: {
          join: 'and',
          terms: [{ field: 'gmail.domain', op: 'is', value: 'stripe.com', label: 'stripe.com' }],
        },
      },
    });
    expect(
      store.memory.list().memories.map((memory) => [memory.kind, memory.text, memory.projectId]),
    ).toEqual([['rule', expect.stringMatching(/stripe\.com → Receipts \(Bucket\)$/), null]]);
  });

  it('learns a memory once: the same key again adds its sources, and a deleted one is never learned again', () => {
    const one = issue('i1', 'OPS-1', 'Relay retries');
    const two = issue('i2', 'OPS-2', 'Relay backoff');
    const first = store.memory.learn({
      kind: 'fact',
      key: 'relay-launch',
      text: 'Relay launches in November',
      confirmed: false,
      sources: [one],
    });
    const again = store.memory.learn({
      kind: 'fact',
      key: 'relay-launch',
      text: 'Relay launches in November',
      confirmed: false,
      sources: [two],
    });
    expect(again?.id).toBe(first?.id);
    expect(again?.sources.map((source) => source.itemId).sort()).toEqual([one, two].sort());
    expect(store.memory.list().memories).toHaveLength(1);

    store.memory.change({ type: 'delete', memoryId: first?.id as string });
    expect(store.memory.list().memories).toEqual([]);
    expect(
      store.memory.learn({
        kind: 'fact',
        key: 'relay-launch',
        text: 'Relay launches',
        confirmed: false,
        sources: [],
      }),
    ).toBeNull();
    expect(store.memory.knows(['relay-launch', 'something-else'])).toEqual(new Set(['relay-launch']));
  });

  it('lets the User confirm, edit (which confirms) and delete memories, but never edit a Rule here', () => {
    const relay = issue('i1', 'OPS-1', 'Relay retries');
    const fact = store.memory.learn({
      kind: 'fact',
      text: 'Priya works on TL',
      confirmed: false,
      sources: [relay],
    });
    const other = store.memory.learn({
      kind: 'fact',
      text: 'Dana leads TX',
      confirmed: false,
      sources: [relay],
    });
    clock += 5000;

    expect(store.memory.change({ type: 'confirm', memoryId: fact?.id as string }).memory).toMatchObject({
      confirmed: true,
      updatedAt: clock,
    });
    expect(
      store.memory.change({ type: 'edit', memoryId: other?.id as string, text: '  Dana leads Tactics ' })
        .memory,
    ).toMatchObject({ text: 'Dana leads Tactics', confirmed: true });
    expect(store.memory.change({ type: 'delete', memoryId: fact?.id as string }).memory).toBeNull();
    expect(store.memory.list().memories.map((memory) => memory.text)).toEqual(['Dana leads Tactics']);

    store.changeRule({
      type: 'create',
      rule: {
        target: { kind: 'project', projectId: tl.id },
        when: { join: 'and', terms: [{ field: 'linear.team', op: 'is', value: OPS.id, label: 'OPS' }] },
      },
    });
    const rule = store.memory.list().memories.find((memory) => memory.kind === 'rule');
    expect(() => store.memory.change({ type: 'edit', memoryId: rule?.id as string, text: 'No' })).toThrow(
      /Rules list/,
    );
    expect(() => store.memory.change({ type: 'confirm', memoryId: 'missing' })).toThrow(/No memory/);
  });

  it('flags a fact for review when its source is deleted, until the User keeps it', () => {
    const relay = issue('i1', 'OPS-1', 'Relay retries');
    const fact = store.memory.learn({
      kind: 'fact',
      text: 'Relay launches in November',
      confirmed: true,
      sources: [relay],
    });
    const example = store.memory.learn({
      kind: 'example',
      text: 'OPS-1 belongs to TX',
      keywords: 'Relay retries',
      confirmed: true,
      sources: [relay],
    });
    clock += 1000;
    store.record({ type: 'delete', itemId: relay }, user);

    const listed = store.memory.list();
    expect(listed.forReview.map((memory) => memory.id)).toEqual([fact?.id]);
    expect(listed.forReview[0]?.sources[0]?.item?.deletedAt).toBe(clock);
    // Examples aren't facts: they stand.
    expect(listed.memories.map((memory) => memory.id)).toEqual([example?.id]);
    // Nor does Ares use a fact waiting for review.
    expect(store.memory.lookup({ text: 'Relay launches November' }).map((memory) => memory.id)).toEqual([
      example?.id,
    ]);

    store.memory.change({ type: 'keep', memoryId: fact?.id as string });
    expect(store.memory.list().forReview).toEqual([]);
    expect(store.memory.list().memories).toHaveLength(2);
  });

  it('finds memories by their words as they are saved, and the page searches them as the User types', () => {
    const relay = issue('i1', 'OPS-1', 'Relay retries');
    store.memory.learn({
      kind: 'example',
      text: 'OPS-1 belongs to TX, not TL',
      keywords: 'Relay retries Operations',
      confirmed: true,
      sources: [relay],
    });
    store.memory.learn({
      kind: 'fact',
      text: 'Longtail’s beta launches in November',
      confirmed: true,
      sources: [],
    });
    store.memory.change({ type: 'add-preference', text: 'Never file newsletters' });

    const texts = (query: string) => store.memory.list({ text: query }).memories.map((memory) => memory.text);
    expect(texts('long')).toEqual(['Longtail’s beta launches in November']);
    // Its keywords find it too, though they are never shown.
    expect(texts('relay')).toEqual(['OPS-1 belongs to TX, not TL']);
    expect(texts('beta nov')).toEqual(['Longtail’s beta launches in November']);
    expect(texts('nothing like it')).toEqual([]);
    // Palette search finds the same.
    expect(store.search.query({ text: 'newsl' }).memories?.map((memory) => memory.text)).toEqual([
      'Never file newsletters',
    ]);
  });

  it('looks up the memories about an Item by its words and by who and what it involves, best first', () => {
    const priya = { id: 'user-priya', name: 'Priya Patel', email: 'priya@acme.test' };
    const relay = issue('i1', 'OPS-1', 'Relay retries', priya);
    const priyaId = store.people.list().find((person) => person.name === 'Priya Patel')?.id as string;
    const works = store.memory.learn({
      kind: 'fact',
      text: 'Priya Patel works mostly on TL',
      confirmed: false,
      personId: priyaId,
      projectId: tl.id,
      handles: ['linear:user-priya'],
      sources: [relay],
    });
    const example = store.memory.learn({
      kind: 'example',
      text: 'OPS-1 belongs to TX, not TL',
      keywords: 'Relay retries Operations',
      confirmed: true,
      projectId: tx.id,
      sources: [relay],
    });
    store.memory.learn({ kind: 'fact', text: 'The office moves in December', confirmed: true, sources: [] });

    // An Item about Relay assigned to Priya: the example by its words, the fact by her handle.
    const found = store.memory.lookup({
      text: 'Relay timeouts on the edge nodes',
      handles: ['priya@acme.test'],
    });
    expect(found.map((memory) => memory.id).sort()).toEqual([works?.id, example?.id].sort());
    expect(found.find((memory) => memory.id === works?.id)?.foundBy).toEqual(['fields']);
    expect(found.find((memory) => memory.id === example?.id)?.foundBy).toEqual(['words']);
    // By the Person, by the Project, and only the kinds asked for.
    expect(store.memory.lookup({ text: '', personIds: [priyaId] }).map((memory) => memory.id)).toEqual([
      works?.id,
    ]);
    expect(
      store.memory.lookup({ text: 'relay', kinds: ['fact'], projectIds: [tl.id] }).map((memory) => memory.id),
    ).toEqual([works?.id]);
    expect(store.memory.lookup({ text: 'quarterly numbers' })).toEqual([]);
  });

  it('keeps its word index across restarts, and rebuilds it when it is missing', () => {
    store.memory.learn({
      kind: 'fact',
      text: 'Longtail’s beta launches in November',
      confirmed: true,
      sources: [],
    });
    store.close();
    open();
    expect(store.memory.lookup({ text: 'beta' })).toHaveLength(1);
    store.close();
    const raw = new Database(join(dir, 'commander.db'));
    raw.exec('DROP TABLE memory_words');
    raw.close();
    open();
    expect(store.memory.lookup({ text: 'beta' })).toHaveLength(1);
  });
});
