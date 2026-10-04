import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ActionContext, type EventDetail, type SourceItem, zonedTime } from '@commander/domain';
import { createModelClient, type ModelProviderAdapter, type ProviderRequest } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { BLOCK_TIME_FOR_TODOS, blockTimeForTodosJob } from './block-time-for-todos';
import { createJobRunner, type JobRunner } from './runner';

// "Block time for Todos" through the runner, on a real Item store with the gate deciding, an
// injectable clock and time zone, and a fake model provider answering with recorded-style replies. Free
// time is worked out in code; Ares only picks among the free slots, and his picks are checked again
// before they reach the gate.

const user: ActionContext = { by: { kind: 'user' } };
const LONDON = 'Europe/London';
const ACCOUNT = 'google:104512345678901234567';
const PRIMARY = 'alex@gmail.test';
const WORK = 'outlook:fake-tenant:sam';
// Monday 5 October 2026, 08:00 in London.
const at = (day: string, time: string) => zonedTime(day, time, LONDON);
const MONDAY_8AM = at('2026-10-05', '08:00');

let dir: string;
let clock: number;
let store: ItemStore;
let gate: Gate;
let runner: JobRunner;
let calls: ProviderRequest[];
let script: string[];
let fix: string;
let eng412: string;

const provider: ModelProviderAdapter = {
  async send(request) {
    calls.push(request);
    return {
      text: script.shift() ?? '{"blocks":[]}',
      usage: { inputTokens: 2_400, cachedTokens: 0, outputTokens: 300 },
    };
  },
  stream: () => Promise.reject(new Error('not used')),
};

function openAll() {
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  gate = openGate({ itemStore: store });
  runner = createJobRunner({
    jobs: [blockTimeForTodosJob(store, { now: () => clock, timeZone: () => LONDON })],
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
}

function meeting(id: string, start: number, end: number, extra: Partial<EventDetail> = {}): SourceItem {
  return {
    externalId: `${PRIMARY}/${id}`,
    kind: 'event',
    title: id,
    detail: {
      kind: 'event',
      calendar: { id: PRIMARY, name: PRIMARY, colour: '#9fe1e7' },
      accountEmail: PRIMARY,
      start: { at: start, timeZone: LONDON, date: null },
      end: { at: end, timeZone: LONDON, date: null },
      allDay: false,
      location: null,
      description: null,
      organiser: null,
      attendees: [],
      myResponse: null,
      meetingUrl: null,
      busy: true,
      private: false,
      seriesId: null,
      webUrl: null,
      createdByCommander: null,
      ...extra,
    },
  };
}

function todo(title: string, dueOn: string | null = null, extra: Record<string, unknown> = {}) {
  return store.record(
    {
      type: 'create',
      item: {
        kind: 'todo',
        title,
        detail: { kind: 'todo', origin: 'manual', dueOn, backedBy: null, ...extra },
      },
    },
    user,
  ).itemId;
}

function linearTodo(): string {
  store.saveFromSource({
    source: 'linear',
    account: 'linear:ws',
    items: [
      {
        externalId: 'issue-412',
        kind: 'linear-issue',
        title: 'Login fails on Safari',
        detail: {
          kind: 'linear-issue',
          identifier: 'ENG-412',
          url: 'https://linear.app/acme/issue/ENG-412',
          team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
          state: { id: 's1', name: 'Todo', type: 'unstarted', color: '#ccc' },
          priority: 2,
          assignee: null,
          creator: null,
          labels: [],
          cycle: null,
          linearProject: null,
          dueDate: null,
          estimate: 3,
          description: null,
          comments: [],
          createdAt: MONDAY_8AM,
          updatedAt: MONDAY_8AM,
          startedAt: null,
          completedAt: null,
          canceledAt: null,
        },
      },
    ],
  });
  const issue = store.query({ kinds: ['linear-issue'] })[0]?.id as string;
  return store.record(
    {
      type: 'create',
      item: {
        kind: 'todo',
        title: 'Login fails on Safari',
        detail: { kind: 'todo', origin: 'linear', dueOn: null, backedBy: issue },
      },
    },
    user,
  ).itemId;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-focus-job-'));
  clock = MONDAY_8AM;
  calls = [];
  script = [];
  openAll();
  store.calendars.listed(ACCOUNT, 'google-calendar', [
    { id: PRIMARY, name: PRIMARY, colour: '#9fe1e7', primary: true, accessRole: 'owner' },
  ]);
  store.focusSettings.save({ ...store.focusSettings.read(), focusAccount: ACCOUNT });
  store.saveFromSource({
    source: 'google-calendar',
    account: ACCOUNT,
    items: [
      // Monday: booked 09:00–17:00 but for 12:00–13:00. Thursday: a standup 11:00–11:30.
      meeting('workshop-am', at('2026-10-05', '09:00'), at('2026-10-05', '12:00')),
      meeting('workshop-pm', at('2026-10-05', '13:00'), at('2026-10-05', '17:00')),
      meeting('standup', at('2026-10-08', '11:00'), at('2026-10-08', '11:30')),
      // Declined: the time is free.
      meeting('offsite', at('2026-10-06', '09:00'), at('2026-10-06', '18:00'), { myResponse: 'declined' }),
    ],
  });
  fix = todo('Fix the login bug', '2026-10-08');
  eng412 = linearTodo();
  // Done, and so not offered.
  store.record({ type: 'update', itemId: todo('Book the venue'), changes: { status: 'done' } }, user);
});

afterEach(() => {
  runner.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const prompt = () => calls.at(-1)?.messages.at(-1)?.content ?? '';
const refOf = (title: string) => new RegExp(`\\[(T\\d+)\\] ${title}`).exec(prompt())?.[1] ?? 'T?';
const pending = () => gate.activity({ action: BLOCK_TIME_FOR_TODOS, statuses: ['pending'] });

async function plan(reply?: () => unknown) {
  if (reply) {
    // The reply is written once the prompt is known, so it can use the refs the prompt gave.
    const original = provider.send.bind(provider);
    provider.send = async (request) => {
      calls.push(request);
      provider.send = original;
      return {
        text: JSON.stringify(reply()),
        usage: { inputTokens: 2_400, cachedTokens: 0, outputTokens: 300 },
      };
    };
  }
  runner.run(BLOCK_TIME_FOR_TODOS);
  await runner.settled();
}

describe('what Ares is given', () => {
  it('is one Deep call at high thinking, with the free slots of the next 5 working days and the open Todos', async () => {
    await plan();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.reasoningEffort).toBe('high');
    const content = prompt();
    // Free time in the User's zone: Monday's gap, Tuesday whole (the offsite is declined), Thursday
    // round the standup; Friday 9 October is the fifth working day.
    expect(content).toContain('Mon 5 Oct (2026-10-05): 12:00–13:00, 17:00–18:00');
    expect(content).toContain('Tue 6 Oct (2026-10-06): 09:00–18:00');
    expect(content).toContain('Thu 8 Oct (2026-10-08): 09:00–11:00, 11:30–18:00');
    expect(content).toContain('Fri 9 Oct (2026-10-09): 09:00–18:00');
    expect(content).not.toContain('Mon 12 Oct');
    // Each open Todo with what helps judge it.
    expect(content).toMatch(/\[T\d+\] Fix the login bug\nDue: Thu 8 Oct/);
    // A Linear Todo's words came from Linear: outside material, marked line by line.
    expect(content).toMatch(/\[T\d+\] Login fails on Safari\n┆ Linear ENG-412 · priority High · estimate 3/);
    expect(content).not.toContain('Book the venue');
  });

  it('doesn’t run without an Account for focus blocks, when more than one could take them', async () => {
    store.calendars.listed(WORK, 'outlook-calendar', [
      { id: 'AAMk-default=', name: 'Calendar', colour: '#0078d4', primary: true, accessRole: 'owner' },
    ]);
    store.focusSettings.save({ ...store.focusSettings.read(), focusAccount: null });
    await plan();
    expect(calls).toHaveLength(0);
  });

  it('takes the only calendar Account when none is chosen', async () => {
    store.focusSettings.save({ ...store.focusSettings.read(), focusAccount: null });
    await plan();
    expect(calls).toHaveLength(1);
  });
});

describe('what reaches the gate', () => {
  it('keeps the blocks inside free slots, drops the rest, and offers each as Tidy your Sources', async () => {
    await plan(() => ({
      blocks: [
        {
          todoId: refOf('Fix the login bug'),
          start: '2026-10-08T09:00',
          end: '2026-10-08T11:00',
          reason: 'Due Thursday and needs about 2 hours; you’re free Thursday 9–11.',
          confidence: 0.8,
        },
        // Runs into the standup.
        {
          todoId: refOf('Login fails on Safari'),
          start: '2026-10-08T10:30',
          end: '2026-10-08T12:00',
          reason: 'ENG-412 is high priority.',
          confidence: 0.7,
        },
        // Overlaps the first block.
        {
          todoId: refOf('Login fails on Safari'),
          start: '2026-10-08T10:00',
          end: '2026-10-08T11:00',
          reason: 'ENG-412 is high priority.',
          confidence: 0.7,
        },
        // Not a Todo it was given.
        { todoId: 'T9', start: '2026-10-06T09:00', end: '2026-10-06T10:00', reason: 'x', confidence: 0.9 },
        {
          todoId: refOf('Login fails on Safari'),
          start: '2026-10-06T09:00',
          end: '2026-10-06T12:00',
          reason: 'ENG-412 needs about 3 hours; you’re free Tuesday morning.',
          confidence: 0.75,
        },
      ],
    }));
    const offered = pending();
    expect(offered).toHaveLength(2);
    expect(offered.map((each) => each.itemId).sort()).toEqual([fix, eng412].sort());
    const forFix = offered.find((each) => each.itemId === fix);
    expect(forFix).toMatchObject({
      actionKind: 'tidy-sources',
      action: BLOCK_TIME_FOR_TODOS,
      section: 'calendar',
      decision: 'ask',
      confidence: 0.8,
      reason: 'Due Thursday and needs about 2 hours; you’re free Thursday 9–11.',
      itemActions: [
        {
          type: 'create-event',
          event: {
            kind: 'focus-block',
            account: ACCOUNT,
            title: 'Focus: Fix the login bug',
            start: { at: at('2026-10-08', '09:00'), timeZone: LONDON, date: null },
            end: { at: at('2026-10-08', '11:00'), timeZone: LONDON, date: null },
          },
        },
        { type: 'link', from: { step: 0 }, linkType: 'made-from', to: fix },
      ],
    });
    // Nothing is in a calendar until the User accepts.
    expect(
      store
        .query({ kinds: ['event'] })
        .filter((each) => each.detail?.kind === 'event' && each.detail.createdByCommander),
    ).toEqual([]);
  });

  it('offers a Todo once while its suggestion waits, and keeps the waiting suggestion’s time free of others', async () => {
    await plan(() => ({
      blocks: [
        {
          todoId: refOf('Fix the login bug'),
          start: '2026-10-06T09:00',
          end: '2026-10-06T11:00',
          reason: 'Due Thursday.',
          confidence: 0.8,
        },
      ],
    }));
    await plan(() => ({ blocks: [] }));
    expect(prompt()).not.toContain('Fix the login bug');
    expect(prompt()).toContain('Tue 6 Oct (2026-10-06): 11:00–18:00');
  });

  it('doesn’t offer a Todo again on a day the User dismissed it for', async () => {
    const tuesday = () => ({
      blocks: [
        {
          todoId: refOf('Fix the login bug'),
          start: '2026-10-06T09:00',
          end: '2026-10-06T11:00',
          reason: 'Due Thursday.',
          confidence: 0.8,
        },
      ],
    });
    await plan(tuesday);
    gate.dismiss(pending()[0]?.id as number);
    await plan(tuesday);
    expect(pending()).toEqual([]);
    // Another day is fine.
    await plan(() => ({
      blocks: [
        {
          todoId: refOf('Fix the login bug'),
          start: '2026-10-07T09:00',
          end: '2026-10-07T11:00',
          reason: 'Due Thursday.',
          confidence: 0.8,
        },
      ],
    }));
    expect(pending()).toHaveLength(1);
  });

  it('leaves out Todos that already have a focus block to come', async () => {
    await plan(() => ({
      blocks: [
        {
          todoId: refOf('Fix the login bug'),
          start: '2026-10-06T09:00',
          end: '2026-10-06T11:00',
          reason: 'Due Thursday.',
          confidence: 0.8,
        },
      ],
    }));
    gate.accept(pending()[0]?.id as number);
    await plan();
    expect(prompt()).not.toContain('Fix the login bug');
    // The block is busy time now, and listed as planned.
    expect(prompt()).toContain('Tue 6 Oct (2026-10-06): 11:00–18:00');
    expect(prompt()).toContain('Tue 6 Oct 09:00–11:00');
  });
});

describe('when it runs', () => {
  it('runs at the first idle moment of a working day, once that day', async () => {
    runner.trigger({ kind: 'idle' });
    await runner.settled();
    runner.trigger({ kind: 'idle' });
    await runner.settled();
    expect(calls).toHaveLength(1);
    // The next working day, it runs again.
    clock = at('2026-10-06', '08:30');
    runner.trigger({ kind: 'idle' });
    await runner.settled();
    expect(calls).toHaveLength(2);
  });

  it('doesn’t run on idle at the weekend, but does when asked', async () => {
    clock = at('2026-10-10', '10:00');
    runner.trigger({ kind: 'idle' });
    await runner.settled();
    expect(calls).toHaveLength(0);
    runner.run(BLOCK_TIME_FOR_TODOS);
    await runner.settled();
    expect(calls).toHaveLength(1);
  });

  it('has nothing to do with no open Todos', async () => {
    store.record({ type: 'update', itemId: fix, changes: { status: 'done' } }, user);
    store.record({ type: 'delete', itemId: eng412 }, user);
    await plan();
    expect(calls).toHaveLength(0);
  });
});
