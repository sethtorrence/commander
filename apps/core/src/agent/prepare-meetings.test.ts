import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActionContext,
  type Enqueue,
  isMeetingPrep,
  jobDisplayName,
  PREP_LEAD_MS,
  PREPARE_MEETINGS,
} from '@commander/domain';
import {
  createModelClient,
  ModelError,
  type ModelProviderAdapter,
  type ProviderRequest,
} from '@commander/models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { createUpdateQueue, type UpdateQueue } from '../updates/queue';
import { prepareMeetingsJob } from './prepare-meetings';
import { createJobRunner, type JobRunner } from './runner';
import { SUGGEST_TODOS, suggestTodosJob } from './suggest-todos';
import {
  attendee,
  CALENDAR_ACCOUNT,
  chipWithNotes,
  eventItem,
  ME,
  PRIYA,
  syncEvents,
  syncIssues,
} from './testing/meeting-fixtures';

// "Prepare for meetings" through the runner, on fixture Items in a real Item store, gate, model client
// and Update queue, on an injectable clock. Only the model is fake: it answers from the references the
// prompt gave each block, like a recorded reply would.

const MINUTE = 60_000;
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const user: ActionContext = { by: { kind: 'user' } };

type Refs = Map<string, string>;
type Reply = ((refs: Refs, request: ProviderRequest) => unknown) | Error;

let dir: string;
let clock: number;
let store: ItemStore;
let gate: Gate;
let queue: UpdateQueue;
let runner: JobRunner;
let calls: ProviderRequest[];
let prepReplies: Reply[];
let askReplies: Reply[];
let changed: string[][];

// Each block's reference in a prompt (S1, S2…), by the words after it in its label.
function refsIn(request: ProviderRequest): Refs {
  const content = request.messages.at(-1)?.content ?? '';
  const refs: Refs = new Map();
  for (const [, ref, what] of content.matchAll(/label="(S\d+) · ([^"]*)"/g)) refs.set(what ?? '', ref ?? '');
  return refs;
}
const isAsks = (request: ProviderRequest) => request.messages[0]?.content.includes('asks the User to do');

const provider: ModelProviderAdapter = {
  async send(request) {
    calls.push(request);
    const next = (isAsks(request) ? askReplies : prepReplies).shift() ?? (() => ({}));
    if (next instanceof Error) throw next;
    return {
      text: JSON.stringify(next(refsIn(request), request)),
      usage: { inputTokens: 1000, cachedTokens: 0, outputTokens: 200 },
    };
  },
  stream: () => Promise.reject(new Error('not used')),
};

function start() {
  const client = createModelClient({
    settings: () => store.models.settings(),
    providers: { zai: provider },
    ledger: store.models,
    now: () => clock,
  });
  runner = createJobRunner({
    jobs: [
      suggestTodosJob(store, { now: () => clock }),
      prepareMeetingsJob(store, {
        now: () => clock,
        enqueue: (input: Enqueue) => queue.enqueue(input),
        onItemsChanged: (itemIds) => changed.push(itemIds),
      }),
    ],
    client,
    gate,
    store: store.agent,
    now: () => clock,
    tickMs: null,
    log: () => {},
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-prep-'));
  clock = at(5, 9);
  calls = [];
  prepReplies = [];
  askReplies = [];
  changed = [];
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  gate = openGate({ itemStore: store });
  queue = createUpdateQueue({ store: store.updates, now: () => clock });
});

afterEach(() => {
  runner?.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function tick(time: number) {
  clock = time;
  runner.tick();
  await runner.settled();
}

const prepOf = (eventId: string) => {
  const prep = store.meetingPreps([eventId])[0];
  return isMeetingPrep(prep) ? prep : null;
};

// A reply naming the event and the issue by the words in their labels.
const goodReply = (refs: Refs) => {
  const ref = (words: string) => [...refs].find(([what]) => what.includes(words))?.[1] ?? 'S99';
  return {
    about: { text: 'Reviewing the launch checklist', sources: [ref('Meeting')] },
    lastTime: [{ text: 'Priya took the checklist', sources: [ref('Notes')] }],
    open: [
      { text: 'ENG-1 is still in review', sources: [ref('ENG-1')] },
      { text: 'Something Ares made up', sources: ['S42'] },
      { text: 'Naming nothing', sources: [] },
    ],
    raise: [{ text: 'Ask about the vendor', sources: [ref('ENG-1'), ref('Meeting')] }],
  };
};

describe('when it runs', () => {
  it('plans 30 minutes before each meeting with someone else in it, not declined, not cancelled', () => {
    const [sync, solo, declined, later] = syncEvents(store, [
      eventItem('sync', '1:1 with Priya', at(5, 15)),
      eventItem('solo', 'Focus time', at(5, 11), { attendees: [] }),
      eventItem('declined', 'Offsite', at(5, 12), { myResponse: 'declined' }),
      eventItem('later', 'Weekly', at(6, 10)),
    ]);
    const job = prepareMeetingsJob(store, { now: () => clock, enqueue: () => {} });
    const plan = job.triggers.at?.plan(clock) ?? [];
    expect(plan.map((run) => [run.itemIds, run.at, run.until])).toEqual([
      [[sync], at(5, 15) - PREP_LEAD_MS, at(5, 15)],
      [[later], at(6, 10) - PREP_LEAD_MS, at(6, 10)],
    ]);
    expect(plan.flatMap((run) => run.itemIds)).not.toContain(solo);
    expect(plan.flatMap((run) => run.itemIds)).not.toContain(declined);
  });

  it('prepares a meeting half an hour before it, once, as a Deep job at high thinking on the Usage page', async () => {
    const [sync] = syncEvents(store, [eventItem('sync', '1:1 with Priya', at(5, 15))]);
    const settings = store.models.settings();
    store.models.saveSettings({
      ...settings,
      tiers: { ...settings.tiers, deep: { ...settings.tiers.deep, model: 'deep-model' } },
    });
    prepReplies.push(goodReply);
    start();
    runner.replan();
    await tick(at(5, 14, 29));
    expect(calls).toEqual([]);
    await tick(at(5, 14, 30));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.reasoningEffort).toBe('high');
    expect(store.models.usageSummary().byJob).toEqual([
      expect.objectContaining({ job: PREPARE_MEETINGS, calls: 1 }),
    ]);
    expect(calls[0]?.setting.model).toBe('deep-model');
    expect(jobDisplayName(PREPARE_MEETINGS)).toBe('Prepare for meetings');
    expect(prepOf(sync as string)).not.toBeNull();
    await tick(at(5, 14, 40));
    expect(calls).toHaveLength(1);
  });

  it('doesn’t prepare a declined or cancelled meeting, even when asked', async () => {
    const [declined, cancelled] = syncEvents(store, [
      eventItem('declined', 'Offsite', at(5, 12), { myResponse: 'declined' }),
      eventItem('cancelled', 'Standup', at(5, 13)),
    ]);
    store.saveFromSource({ source: 'google-calendar', account: CALENDAR_ACCOUNT, deleted: ['cancelled'] });
    start();
    runner.run(PREPARE_MEETINGS, [declined as string, cancelled as string]);
    await runner.settled();
    expect(calls).toEqual([]);
  });

  it('doesn’t run while its action is Off, and prepares at Ask as at Auto', async () => {
    const [sync] = syncEvents(store, [eventItem('sync', '1:1 with Priya', at(5, 15))]);
    start();
    gate.setLevel({ scope: 'action', action: PREPARE_MEETINGS }, 'off');
    runner.run(PREPARE_MEETINGS, [sync as string]);
    await runner.settled();
    expect(calls).toEqual([]);

    gate.setLevel({ scope: 'action', action: PREPARE_MEETINGS }, 'ask');
    prepReplies.push(goodReply);
    runner.run(PREPARE_MEETINGS, [sync as string]);
    await runner.settled();
    expect(prepOf(sync as string)).not.toBeNull();
  });

  it('respects the month’s cap: nothing is prepared, and the time is tried again while it matters', async () => {
    const [sync] = syncEvents(store, [eventItem('sync', '1:1 with Priya', at(5, 15))]);
    prepReplies.push(new ModelError('over-cap', 'This month’s model spend has reached the cap.'), goodReply);
    start();
    runner.replan();
    await tick(at(5, 14, 30));
    expect(prepOf(sync as string)).toBeNull();
    expect(runner.jobs().find((job) => job.job === PREPARE_MEETINGS)?.lastOutcome).toBe('over-cap');
    await tick(at(5, 14, 31));
    expect(prepOf(sync as string)).not.toBeNull();
  });
});

describe('what it reads', () => {
  it('gives the event, earlier notes and each attendee’s Item a data block of its own, the outside ones untrusted', async () => {
    const [earlier, sync] = syncEvents(store, [
      eventItem('w1', 'Weekly with Priya', at(1, 15), { seriesId: 'weekly' }),
      eventItem('w5', 'Weekly with Priya', at(5, 15), {
        seriesId: 'weekly',
        description: 'Agenda: the launch',
      }),
    ]);
    chipWithNotes(store, '2026-10-01', earlier as string, ['Priya took the checklist']);
    syncIssues(store, [{ id: 'a', title: 'Audit log export', people: [PRIYA] }]);
    prepReplies.push(goodReply);
    start();
    runner.run(PREPARE_MEETINGS, [sync as string]);
    await runner.settled();

    const prompt = calls[0]?.messages.at(-1)?.content ?? '';
    expect([...refsIn(calls[0] as ProviderRequest).keys()]).toEqual([
      expect.stringMatching(/^Meeting/),
      'Notes from the meeting on 2026-10-01',
      expect.stringMatching(/^Linear issue ENG-1/),
    ]);
    expect(prompt).toContain('Agenda: the launch');
    expect(prompt).toContain('Priya took the checklist');
    // The event and the issue are outside blocks; the User's notes aren't.
    expect(prompt.match(/source="outside"/g)).toHaveLength(2);
    expect(prompt.match(/source="the User"/g)).toHaveLength(1);
  });

  it('reads emails with the people in it as they arrive, kind-neutral, each its own outside block', async () => {
    const [sync] = syncEvents(store, [eventItem('sync', '1:1 with Priya', at(5, 15))]);
    store.saveFromSource({
      source: 'gmail',
      account: 'gmail:1',
      items: [
        {
          externalId: 'm1',
          kind: 'email',
          title: 'Vendor contract',
          people: [PRIYA, ME],
          detail: {
            kind: 'email',
            messageId: null,
            inReplyTo: null,
            references: [],
            threadKey: 't1',
            sourceThreadId: null,
            from: { name: 'Priya Patel', address: PRIYA },
            to: [{ name: null, address: ME }],
            cc: [],
            bcc: [],
            replyTo: [],
            subject: 'Vendor contract',
            sentAt: at(4, 10),
            snippet: 'Can we settle the vendor contract on Monday?',
            read: true,
            starred: false,
            inInbox: true,
            sentByMe: false,
            labels: [],
            attachments: [],
            hasInvitation: false,
            listUnsubscribe: null,
            listId: null,
          },
        },
      ],
    });
    prepReplies.push(goodReply);
    start();
    runner.run(PREPARE_MEETINGS, [sync as string]);
    await runner.settled();
    const prompt = calls[0]?.messages.at(-1)?.content ?? '';
    expect(prompt).toMatch(/ref="U\d+" label="S2 · Email · Vendor contract" source="outside">/);
    expect(prompt).toContain('┆ Preview: Can we settle the vendor contract on Monday?');
  });

  it('keeps the call small, whatever the Items hold', async () => {
    const [sync] = syncEvents(store, [
      eventItem('sync', '1:1 with Priya', at(5, 15), { description: 'x '.repeat(20_000) }),
    ]);
    for (let i = 0; i < 40; i++) {
      clock += MINUTE;
      syncIssues(store, [
        { id: `i${i}`, title: `Issue ${i}`, people: [PRIYA], description: 'y '.repeat(5_000) },
      ]);
    }
    prepReplies.push(goodReply);
    start();
    runner.run(PREPARE_MEETINGS, [sync as string]);
    await runner.settled();
    const length = calls[0]?.messages.reduce((sum, message) => sum + message.content.length, 0) ?? 0;
    expect(length).toBeLessThan(40_000);
  });
});

describe('the prep', () => {
  it('keeps only the lines that name real sources, as an Item made by Ares with about and refers-to Links', async () => {
    const [earlier, sync] = syncEvents(store, [
      eventItem('w1', 'Weekly with Priya', at(1, 15), { seriesId: 'weekly' }),
      eventItem('w5', 'Weekly with Priya', at(5, 15), { seriesId: 'weekly' }),
    ]);
    const chip = chipWithNotes(store, '2026-10-01', earlier as string, ['Priya took the checklist']);
    const [issue] = syncIssues(store, [{ id: 'a', title: 'Audit log export', people: [PRIYA] }]);
    prepReplies.push(goodReply);
    start();
    runner.run(PREPARE_MEETINGS, [sync as string]);
    await runner.settled();

    const prep = prepOf(sync as string);
    expect(prep?.title).toBe('Prep: Weekly with Priya');
    expect(prep?.detail).toEqual(
      expect.objectContaining({
        eventId: sync,
        about: { text: 'Reviewing the launch checklist', sources: [sync] },
        lastTime: [{ text: 'Priya took the checklist', sources: [chip] }],
        open: [{ text: 'ENG-1 is still in review', sources: [issue] }],
        raise: [{ text: 'Ask about the vendor', sources: [issue, sync] }],
      }),
    );
    const view = store.get(prep?.id as string);
    expect(view?.links.map((link) => [link.type, link.to.id]).sort()).toEqual(
      [
        ['about', sync],
        ['refers-to', chip],
        ['refers-to', issue],
      ].sort(),
    );
    expect(store.activity({ itemId: prep?.id as string })[0]?.by).toEqual({ kind: 'ares' });
    expect(changed.flat()).toEqual(expect.arrayContaining([prep?.id, sync]));
  });

  it('is replaced by re-running (Prepare now), its Links following', async () => {
    const [sync] = syncEvents(store, [eventItem('sync', '1:1 with Priya', at(5, 15))]);
    const [first, second] = syncIssues(store, [
      { id: 'a', title: 'Audit log export', people: [PRIYA] },
      { id: 'b', title: 'Billing bug', people: [PRIYA] },
    ]);
    prepReplies.push(goodReply, (refs) => ({
      about: { text: 'Billing first', sources: [[...refs].find(([what]) => what.includes('ENG-2'))?.[1]] },
    }));
    start();
    runner.run(PREPARE_MEETINGS, [sync as string]);
    await runner.settled();
    const before = prepOf(sync as string);

    clock += MINUTE;
    runner.run(PREPARE_MEETINGS, [sync as string]);
    await runner.settled();
    const after = prepOf(sync as string);
    expect(after?.id).toBe(before?.id);
    expect(after?.detail.about?.text).toBe('Billing first');
    expect(after?.detail.open).toEqual([]);
    expect(store.query({ kinds: ['meeting-prep'] })).toHaveLength(1);
    const refersTo = store
      .get(after?.id as string)
      ?.links.filter((link) => link.type === 'refers-to')
      .map((link) => link.to.id);
    expect(refersTo).toEqual([second]);
    expect(refersTo).not.toContain(first);
  });

  it('is kept per revision of the event: not prepared again until the event changes', async () => {
    const meeting = eventItem('sync', '1:1 with Priya', at(5, 15));
    const [sync] = syncEvents(store, [meeting]);
    prepReplies.push(goodReply, goodReply);
    start();
    runner.replan();
    await tick(at(5, 14, 30));
    expect(calls).toHaveLength(1);

    // A restart forgets which times ran; the prep for the event as it is still stands.
    runner.stop();
    start();
    runner.replan();
    await tick(at(5, 14, 35));
    expect(calls).toHaveLength(1);

    // The description changed in a sync: prepared again.
    syncEvents(store, [
      { ...meeting, detail: { ...meeting.detail, description: 'Bring the numbers' } } as never,
    ]);
    runner.replan();
    await runner.settled();
    expect(calls.filter((call) => !isAsks(call))).toHaveLength(2);
    expect(prepOf(sync as string)?.detail.preparedAt).toBe(at(5, 14, 35));
  });
});

describe('the Update', () => {
  it('queues Needs you now when the prep is ready, expiring when the meeting ends', async () => {
    const [sync] = syncEvents(store, [eventItem('sync', '1:1 with Priya', at(5, 15))]);
    prepReplies.push(goodReply);
    start();
    runner.replan();
    await tick(at(5, 14, 30));
    const [line, ...others] = queue.list();
    expect(others).toEqual([]);
    expect(line).toEqual(
      expect.objectContaining({
        group: 'now',
        section: 'calendar',
        itemIds: [sync],
        expiresAt: at(5, 15, 30),
        about: {
          kind: 'meeting-prep',
          eventId: sync,
          prepId: prepOf(sync as string)?.id,
          title: '1:1 with Priya',
          startsAt: at(5, 15),
        },
      }),
    );
    clock = at(5, 15, 30);
    expect(queue.list()).toEqual([]);
  });
});

describe('Todos the meeting asks for', () => {
  const asking = () =>
    syncEvents(store, [
      eventItem('sync', '1:1 with Priya', at(5, 15), {
        description: 'Please read the deck before we meet.',
      }),
    ])[0] as string;

  it('become a Todo of Ares’s, due that day, in the event’s Project, made from the event, when he is sure', async () => {
    const projectId = store.changeProject({
      type: 'create',
      project: { name: 'Longtail', code: 'LT', accent: 'blue' },
    }).project?.id as string;
    const sync = asking();
    store.record({ type: 'update', itemId: sync, changes: { filing: { projectId, filedBy: 'user' } } }, user);
    prepReplies.push(goodReply);
    askReplies.push((refs) => ({
      todos: [{ title: 'Read the deck.', sources: [[...refs.values()][0]], confidence: 0.95 }],
    }));
    start();
    runner.run(PREPARE_MEETINGS, [sync]);
    await runner.settled();

    const [todo, ...others] = store.query({ kinds: ['todo'] });
    expect(others).toEqual([]);
    expect(todo).toEqual(
      expect.objectContaining({
        title: 'Read the deck',
        filing: { projectId, filedBy: 'inherited' },
        detail: { kind: 'todo', origin: 'ares', dueOn: '2026-10-05', backedBy: null },
      }),
    );
    expect(store.get(todo?.id as string)?.links).toEqual([
      expect.objectContaining({ type: 'made-from', to: expect.objectContaining({ id: sync }) }),
    ]);
    // Through the gate, as Suggest Todos, about the event itself (not a chained suggestion).
    expect(gate.activity()).toEqual([
      expect.objectContaining({ action: SUGGEST_TODOS, itemId: sync, chained: false, status: 'done' }),
    ]);
    // The asks call read the invitation only.
    const asks = calls.find(isAsks);
    expect(asks?.messages.at(-1)?.content.match(/data-[0-9a-f]+ /g)).toHaveLength(1);
  });

  it('wait as a suggestion on the event when he isn’t sure, and aren’t offered twice', async () => {
    const sync = asking();
    const unsure = () => ({ todos: [{ title: 'Read the deck', sources: ['S1'], confidence: 0.5 }] });
    prepReplies.push(goodReply, goodReply);
    askReplies.push(unsure, unsure);
    start();
    runner.run(PREPARE_MEETINGS, [sync]);
    await runner.settled();
    runner.run(PREPARE_MEETINGS, [sync]);
    await runner.settled();
    expect(store.query({ kinds: ['todo'] })).toEqual([]);
    expect(gate.activity()).toEqual([
      expect.objectContaining({ action: SUGGEST_TODOS, itemId: sync, status: 'pending' }),
    ]);
  });

  it('aren’t asked about when the invitation says nothing', async () => {
    const [sync] = syncEvents(store, [
      eventItem('sync', '1:1 with Priya', at(5, 15), {
        attendees: [attendee(ME, { organiser: true }), attendee(PRIYA)],
      }),
    ]);
    prepReplies.push(goodReply);
    start();
    runner.run(PREPARE_MEETINGS, [sync as string]);
    await runner.settled();
    expect(calls.filter(isAsks)).toEqual([]);
  });
});
