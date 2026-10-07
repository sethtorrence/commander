import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActionContext,
  AGENT_JOB_NAMES,
  type EventDetail,
  PROPOSE_EVENTS_FROM_EMAIL,
  type SourceItem,
  zonedTime,
} from '@commander/domain';
import { createModelClient, type ModelProviderAdapter, type ProviderRequest } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { allowCloudMail, deliver, GMAIL, type MailInput } from './fixtures/emails';
import { proposeEmailEventsJob } from './propose-email-events';
import { CREATE_EVENTS_WITH_GUESTS, HOLD_TIME } from './propose-events';
import { createJobRunner, type JobRunner } from './runner';

// "Propose events from email" (#144) through the runner, on a real Item store with the gate deciding,
// a faked clock and a London time zone, and a fake model provider answering with recorded-style
// replies on fixture mail: the pre-filter in code, attendees resolved from the email, the time checked
// against the User's calendars, and every proposal a chained suggestion (always Ask, with its cause)
// whatever the settings. Create makes the event with a made-from Link to the email and its Project.

const user: ActionContext = { by: { kind: 'user' } };
const LONDON = 'Europe/London';
const PRIMARY = 'alex@gmail.test';
const at = (day: string, time: string) => zonedTime(day, time, LONDON);
// Saturday 3 October 2026, 10:00 in London; Thursday is the 8th.
const NOW = at('2026-10-03', '10:00');

let dir: string;
let store: ItemStore;
let gate: Gate;
let runner: JobRunner;
let calls: ProviderRequest[];
let reply: (prompt: string) => unknown;

const provider: ModelProviderAdapter = {
  async send(request) {
    calls.push(request);
    const prompt = String(request.messages.at(-1)?.content ?? '');
    return {
      text: JSON.stringify(reply(prompt)),
      usage: { inputTokens: 1_500, cachedTokens: 0, outputTokens: 120 },
    };
  },
  stream: () => Promise.reject(new Error('not used')),
};

function event(id: string, start: number, end: number): SourceItem {
  const detail: EventDetail = {
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
  };
  return { externalId: `${PRIMARY}/${id}`, kind: 'event', title: id, detail };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  dir = mkdtempSync(join(tmpdir(), 'commander-email-events-'));
  calls = [];
  reply = () => ({ events: [], steering: [] });
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => NOW,
  });
  gate = openGate({ itemStore: store });
  runner = createJobRunner({
    jobs: [proposeEmailEventsJob(store, { now: () => NOW, timeZone: () => LONDON })],
    client: createModelClient({
      settings: () => store.models.settings(),
      providers: { zai: provider },
      ledger: store.models,
      now: () => NOW,
    }),
    gate,
    store: store.agent,
    now: () => NOW,
    log: () => {},
  });
  allowCloudMail(store);
  store.calendars.listed(GMAIL, 'google-calendar', [
    { id: PRIMARY, name: PRIMARY, colour: '#9fe1e7', primary: true, accessRole: 'owner' },
  ]);
  // Friday: board prep 11:00–12:00.
  store.saveFromSource({
    source: 'google-calendar',
    account: GMAIL,
    items: [event('Board prep', at('2026-10-09', '11:00'), at('2026-10-09', '12:00'))],
  });
});

afterEach(() => {
  runner.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

const THURSDAY_AT_3: MailInput = {
  id: 'pricing',
  subject: 'Pricing call',
  text: 'Hi Alex,\n\nHow about Thursday at 3 for the pricing call?\n\nDana',
};
const RECORDED = {
  events: [
    {
      title: 'Pricing call with Dana',
      attendees: ['Dana'],
      durationMinutes: 30,
      when: { at: '2026-10-08T15:00' },
      confidence: 0.92,
    },
  ],
  steering: [],
};

async function arriveAndRun(messages: MailInput[]) {
  const ids = deliver(store, NOW, messages);
  runner.trigger({ kind: 'items-arrived', itemIds: messages.map((each) => ids[each.id] as string) });
  await runner.settled();
  return ids;
}

const pending = () =>
  gate
    .activity({ statuses: ['pending'] })
    .filter((row) => row.action === CREATE_EVENTS_WITH_GUESTS || row.action === HOLD_TIME);

describe('events from email', () => {
  it('“How about Thursday at 3?”: one Deep call, and a chained suggestion showing its cause', async () => {
    reply = () => RECORDED;
    const ids = await arriveAndRun([THURSDAY_AT_3]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.reasoningEffort).toBe('high');
    const prompt = String(calls[0]?.messages.at(-1)?.content);
    expect(prompt).toMatch(/label="E1 · Email" source="outside">/);
    expect(prompt).toContain('Thu 8 Oct = 2026-10-08');
    expect(AGENT_JOB_NAMES[PROPOSE_EVENTS_FROM_EMAIL]).toBe('Propose events from email');

    const [row] = pending();
    expect(row).toMatchObject({
      itemId: ids.pricing,
      action: CREATE_EVENTS_WITH_GUESTS,
      actionKind: 'act-for-you',
      decision: 'ask',
      chained: true,
      causedBy: { itemId: ids.pricing },
      reason: 'Dana wrote “Hi Alex, How about Thursday at 3 for the pricing call? Dana”. You’re free then.',
    });
    expect(row?.cause?.item?.id).toBe(ids.pricing);
    const step = row?.itemActions[0];
    expect(step?.type === 'create-event' && step.event).toMatchObject({
      kind: 'meeting',
      account: GMAIL,
      calendarId: PRIMARY,
      title: 'Pricing call with Dana',
      start: { at: at('2026-10-08', '15:00') },
      end: { at: at('2026-10-08', '15:30') },
      attendees: [{ email: 'dana@northwind.test', name: 'Dana Whitfield' }],
    });
    // Nothing is in the calendar until the User says Create.
    expect(store.query({ kinds: ['event'] }).map((each) => each.title)).toEqual(['Board prep']);
  });

  it('Create makes the event with a made-from Link to the email and the email’s Project', async () => {
    reply = () => RECORDED;
    const ids = deliver(store, NOW, [THURSDAY_AT_3]);
    const lt = store.changeProject({
      type: 'create',
      project: { name: 'Longtail', code: 'LT', accent: 'blue' },
    }).project?.id as string;
    store.record(
      {
        type: 'update',
        itemId: ids.pricing as string,
        changes: { filing: { projectId: lt, filedBy: 'user' } },
      },
      user,
    );
    runner.trigger({ kind: 'items-arrived', itemIds: [ids.pricing as string] });
    await runner.settled();
    const [row] = pending();
    gate.accept(row?.id as number);
    const made = store.query({ kinds: ['event'] }).find((each) => each.title === 'Pricing call with Dana');
    expect(made?.filing).toEqual({ projectId: lt, filedBy: 'inherited' });
    expect(store.get(made?.id as string)?.links).toEqual([
      expect.objectContaining({ type: 'made-from', to: expect.objectContaining({ id: ids.pricing }) }),
    ]);
  });

  it('is always Ask, whatever the settings: time for the User alone at Auto still waits', async () => {
    gate.setLevel({ scope: 'action', action: HOLD_TIME }, 'auto');
    reply = () => ({
      events: [
        {
          title: 'Read the pricing deck',
          attendees: [],
          durationMinutes: 60,
          when: { at: '2026-10-08T10:00' },
          confidence: 0.99,
        },
      ],
      steering: [],
    });
    await arriveAndRun([THURSDAY_AT_3]);
    const [row] = pending();
    expect(row).toMatchObject({
      action: HOLD_TIME,
      actionKind: 'tidy-sources',
      decision: 'ask',
      chained: true,
    });
    expect(store.query({ kinds: ['event'] }).map((each) => each.title)).toEqual(['Board prep']);
  });

  it('the gate chains an event made from an email even when a job forgets to', () => {
    const ids = deliver(store, NOW, [THURSDAY_AT_3]);
    const email = ids.pricing as string;
    gate.setLevel({ scope: 'action', action: HOLD_TIME }, 'auto');
    const outcome = gate.propose({
      itemId: email,
      action: HOLD_TIME,
      actionKind: 'tidy-sources',
      section: 'calendar',
      confidence: 1,
      reason: 'Forgot to chain it',
      causedBy: { itemId: email },
      itemActions: [
        {
          type: 'create-event',
          event: {
            kind: 'meeting',
            account: GMAIL,
            title: 'Held',
            start: { at: at('2026-10-08', '10:00'), timeZone: LONDON, date: null },
            end: { at: at('2026-10-08', '11:00'), timeZone: LONDON, date: null },
            attendees: [],
          },
        },
      ],
    });
    expect(outcome.decision).toBe('ask');
    expect(outcome.decision === 'ask' && outcome.suggestion.chained).toBe(true);
  });

  it('reads only mail that passes the pre-filter, from real people, with no invitation of its own', async () => {
    await arriveAndRun([
      { id: 'numbers', subject: 'Q3 numbers', text: 'Can you send me the numbers?' },
      {
        id: 'webinar',
        subject: 'Join our webinar on Thursday at 3',
        from: { name: 'Northwind', address: 'news@northwind.test' },
        listUnsubscribe: '<https://news.northwind.test/u/1>',
      },
      { id: 'invite', subject: 'Invitation: Pricing review @ Thu 15:00', hasInvitation: true },
    ]);
    expect(calls).toHaveLength(0);
  });

  it('never offers again for an email whose proposal was dismissed', async () => {
    reply = () => RECORDED;
    const ids = await arriveAndRun([THURSDAY_AT_3]);
    gate.dismiss(pending()[0]?.id as number);
    runner.trigger({ kind: 'items-arrived', itemIds: [ids.pricing as string] });
    await runner.settled();
    expect(calls).toHaveLength(1);
    expect(pending()).toEqual([]);
  });

  it('drops a time already past', async () => {
    reply = () => ({ events: [{ ...RECORDED.events[0], when: { at: '2026-10-02T15:00' } }], steering: [] });
    await arriveAndRun([THURSDAY_AT_3]);
    expect(pending()).toEqual([]);
  });
});
