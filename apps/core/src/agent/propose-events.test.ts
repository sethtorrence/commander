import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActionContext,
  AGENT_JOB_NAMES,
  type EventDetail,
  type Item,
  type SourceItem,
  zonedTime,
} from '@commander/domain';
import { createModelClient, type ModelProviderAdapter, type ProviderRequest } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { CREATE_EVENTS_WITH_GUESTS, HOLD_TIME, PROPOSE_EVENTS, proposeEventsJob } from './propose-events';
import { createJobRunner, type JobRunner } from './runner';

// "Propose events" through the runner, on a real Item store with the gate deciding, an injectable clock
// and time zone, and a fake model provider answering with recorded-style replies on fixture Blocks: the
// pre-filter in code, attendee resolution (by address, then names on the User's events, then People),
// exact times checked against the User's calendars, windows turned into free slots, and every event with
// guests left as a suggestion.

const user: ActionContext = { by: { kind: 'user' } };
const LONDON = 'Europe/London';
const ACCOUNT = 'google:104512345678901234567';
const PRIMARY = 'alex@gmail.test';
const at = (day: string, time: string) => zonedTime(day, time, LONDON);
// Saturday 3 October 2026, 10:00 in London; Tuesday is the 6th.
const SATURDAY_10AM = at('2026-10-03', '10:00');
const TODAY = '2026-10-03';

let dir: string;
let clock: number;
let store: ItemStore;
let gate: Gate;
let runner: JobRunner;
let calls: ProviderRequest[];
let reply: (prompt: string) => unknown;
let note: Item;
let position = 0;

const provider: ModelProviderAdapter = {
  async send(request) {
    calls.push(request);
    const prompt = request.messages.at(-1)?.content ?? '';
    return {
      text: JSON.stringify(reply(typeof prompt === 'string' ? prompt : '')),
      usage: { inputTokens: 1_800, cachedTokens: 0, outputTokens: 200 },
    };
  },
  stream: () => Promise.reject(new Error('not used')),
};

function event(id: string, start: number, end: number, extra: Partial<EventDetail> = {}): SourceItem {
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

const guest = (email: string, name: string) => ({
  email,
  name,
  self: false,
  response: 'accepted' as const,
  organiser: false,
  optional: false,
  resource: false,
});

function write(text: string, parentId: string | null = null): string {
  position += 1;
  return store.record(
    {
      type: 'create',
      item: {
        kind: 'block',
        title: text,
        detail: {
          kind: 'block',
          dailyNoteId: note.id,
          parentId,
          position: `a${position}`,
          text,
          folded: false,
        },
      },
    },
    user,
  ).itemId;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-propose-events-'));
  clock = SATURDAY_10AM;
  calls = [];
  reply = () => ({ events: [] });
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  gate = openGate({ itemStore: store });
  runner = createJobRunner({
    jobs: [proposeEventsJob(store, { now: () => clock, timeZone: () => LONDON })],
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
  store.calendars.listed(ACCOUNT, 'google-calendar', [
    { id: PRIMARY, name: PRIMARY, colour: '#9fe1e7', primary: true, accessRole: 'owner' },
  ]);
  store.saveFromSource({
    source: 'google-calendar',
    account: ACCOUNT,
    items: [
      // Last week's renewal call: Leo Park was on it, which is how Commander knows his address.
      event('renewal', at('2026-09-29', '15:00'), at('2026-09-29', '16:00'), {
        attendees: [guest('leo.park@acme.test', 'Leo Park')],
      }),
      // Tuesday: board prep 15:00–16:00; Monday booked 09:00–17:00.
      event('Board prep', at('2026-10-06', '15:00'), at('2026-10-06', '16:00')),
      event('Workshop', at('2026-10-05', '09:00'), at('2026-10-05', '17:00')),
    ],
  });
  note = store.ensureDailyNote(TODAY, user);
});

afterEach(() => {
  runner.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const prompt = () => {
  const content = calls.at(-1)?.messages.at(-1)?.content;
  return typeof content === 'string' ? content : '';
};
const refOf = (content: string, text: string) =>
  new RegExp(`\\[(B\\d+)\\] ${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).exec(content)?.[1] ?? 'B?';
const pending = () =>
  gate
    .activity({ statuses: ['pending'] })
    .filter((row) => row.action === CREATE_EVENTS_WITH_GUESTS || row.action === HOLD_TIME);
const eventOf = (row: ReturnType<typeof pending>[number]) => {
  const step = row.itemActions.find((action) => action.type === 'create-event');
  if (step?.type !== 'create-event') throw new Error('No event');
  return step.event;
};

async function run() {
  runner.run(PROPOSE_EVENTS);
  await runner.settled();
}

describe('what Ares is given', () => {
  it('only the Blocks that pass the pre-filter, in one Deep call at high thinking, with the days ahead', async () => {
    write('need to send Dana the Q3 numbers');
    write('call with Leo Tuesday at 2');
    write('Priya leads the reliability push');
    await run();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.reasoningEffort).toBe('high');
    const content = prompt();
    expect(content).toMatch(/\[B1\] call with Leo Tuesday at 2/);
    expect(content).not.toContain('Q3 numbers');
    expect(content).not.toContain('reliability');
    expect(content).toContain('Now: Sat 3 Oct (2026-10-03) 10:00');
    expect(content).toContain('Tue 6 Oct = 2026-10-06');
    // Each run is on the Usage page under its own name.
    expect(store.models.usageSummary().byJob.map((row) => row.job)).toEqual([PROPOSE_EVENTS]);
    expect(AGENT_JOB_NAMES[PROPOSE_EVENTS]).toBe('Propose events');
  });

  it('makes no call when nothing written passes the pre-filter', async () => {
    write('need to send Dana the Q3 numbers');
    await run();
    expect(calls).toHaveLength(0);
  });
});

describe('a proposed event', () => {
  it('“call with Leo Tuesday at 2”: Leo’s address from the User’s events, the time free, a suggestion on the Block', async () => {
    const block = write('call with Leo Tuesday at 2');
    reply = (content) => ({
      events: [
        {
          blockId: refOf(content, 'call with Leo Tuesday at 2'),
          title: 'Call with Leo',
          attendees: ['Leo'],
          durationMinutes: 30,
          when: { at: '2026-10-06T14:00' },
          confidence: 0.95,
        },
      ],
    });
    await run();
    const [row] = pending();
    expect(row).toMatchObject({
      action: CREATE_EVENTS_WITH_GUESTS,
      actionKind: 'act-for-you',
      decision: 'ask',
      itemId: block,
      reason: 'You wrote “call with Leo Tuesday at 2” in your Daily Note. You’re free then.',
    });
    expect(eventOf(row as never)).toMatchObject({
      kind: 'meeting',
      account: ACCOUNT,
      calendarId: PRIMARY,
      title: 'Call with Leo',
      start: { at: at('2026-10-06', '14:00') },
      end: { at: at('2026-10-06', '14:30') },
      attendees: [{ email: 'leo.park@acme.test', name: 'Leo Park' }],
      guestsToFill: [],
    });
    expect(row?.itemActions[1]).toEqual({
      type: 'link',
      from: { step: 0 },
      linkType: 'made-from',
      to: block,
    });
    // Nothing is in the calendar until the User says Create.
    expect(store.query({ kinds: ['event'] }).filter((each) => each.title === 'Call with Leo')).toEqual([]);
  });

  it('takes an address written in the Block as it is, and leaves a name it can’t place blank to fill in', async () => {
    write('lunch with omar and dana@contoso.test on Tuesday at 12:30');
    reply = (content) => ({
      events: [
        {
          blockId: refOf(content, 'lunch with omar'),
          title: 'Lunch',
          attendees: ['Omar', 'dana@contoso.test', 'made.up@nowhere.test'],
          durationMinutes: 60,
          when: { at: '2026-10-06T12:30' },
          confidence: 0.9,
        },
      ],
    });
    await run();
    const event = eventOf(pending()[0] as never);
    expect(event.attendees).toEqual([{ email: 'dana@contoso.test', name: null }]);
    // An address Ares made up isn't trusted: it's a name to fill in, like Omar.
    expect(event.guestsToFill).toEqual(['Omar', 'made.up@nowhere.test']);
  });

  it('says what an exact time clashes with', async () => {
    write('sync with Leo Tuesday 3pm');
    reply = (content) => ({
      events: [
        {
          blockId: refOf(content, 'sync with Leo'),
          title: 'Sync with Leo',
          attendees: ['Leo'],
          durationMinutes: 30,
          when: { at: '2026-10-06T15:00' },
          confidence: 0.9,
        },
      ],
    });
    await run();
    expect(pending()[0]?.reason).toBe(
      'You wrote “sync with Leo Tuesday 3pm” in your Daily Note. It clashes with “Board prep”.',
    );
  });

  it('turns a window into the first free slot in it, inside working hours', async () => {
    write('set up a call with Leo next week about the Acme renewal');
    reply = (content) => ({
      events: [
        {
          blockId: refOf(content, 'set up a call'),
          title: 'Acme renewal: call with Leo',
          attendees: ['Leo'],
          durationMinutes: 30,
          when: { window: { from: '2026-10-05', to: '2026-10-09' } },
          confidence: 0.85,
        },
      ],
    });
    await run();
    // Monday is booked until 17:00.
    expect(eventOf(pending()[0] as never)).toMatchObject({
      start: { at: at('2026-10-05', '17:00') },
      end: { at: at('2026-10-05', '17:30') },
    });
  });

  it('drops what it can’t use: a Block it wasn’t given, one named twice, a time already past', async () => {
    write('call with Leo Tuesday at 2');
    reply = (content) => {
      const ref = refOf(content, 'call with Leo');
      const base = { title: 'Call', attendees: ['Leo'], durationMinutes: 30, confidence: 0.9 };
      return {
        events: [
          { ...base, blockId: 'B9', when: { at: '2026-10-06T14:00' } },
          { ...base, blockId: ref, when: { at: '2026-10-02T14:00' } },
          { ...base, blockId: ref, when: { at: '2026-10-06T14:00' } },
        ],
      };
    };
    await run();
    expect(pending()).toEqual([]);
  });

  it('with nobody else is time held for the User: Tidy your Sources, so it follows the Autonomy settings', async () => {
    write('block Thursday morning for the report');
    gate.setLevel({ scope: 'action', action: HOLD_TIME }, 'auto');
    reply = (content) => ({
      events: [
        {
          blockId: refOf(content, 'block Thursday'),
          title: 'Report',
          attendees: [],
          durationMinutes: 120,
          when: { at: '2026-10-08T09:00' },
          confidence: 0.9,
        },
      ],
    });
    await run();
    const made = store.query({ kinds: ['event'] }).find((each) => each.title === 'Report');
    expect(made?.detail).toMatchObject({ createdByCommander: 'meeting', attendees: [] });
  });

  it('with guests is always a suggestion, whatever the settings say', async () => {
    write('call with Leo Tuesday at 2');
    gate.setLevel({ scope: 'everywhere', actionKind: 'tidy-sources' }, 'auto');
    reply = (content) => ({
      events: [
        {
          blockId: refOf(content, 'call with Leo'),
          title: 'Call with Leo',
          attendees: ['Leo'],
          durationMinutes: 30,
          when: { at: '2026-10-06T14:00' },
          confidence: 1,
        },
      ],
    });
    await run();
    expect(pending()).toHaveLength(1);
    expect(store.query({ kinds: ['event'] }).filter((each) => each.title === 'Call with Leo')).toEqual([]);
  });

  it('dismissed, isn’t offered again for the same Block text', async () => {
    const block = write('call with Leo Tuesday at 2');
    reply = (content) => ({
      events: [
        {
          blockId: refOf(content, 'call with Leo'),
          title: 'Call with Leo',
          attendees: ['Leo'],
          durationMinutes: 30,
          when: { at: '2026-10-06T14:00' },
          confidence: 0.9,
        },
      ],
    });
    await run();
    gate.dismiss(pending()[0]?.id as number);
    await run();
    expect(calls).toHaveLength(1);
    expect(pending()).toEqual([]);
    // Changed, it is looked at again.
    const item = store.get(block)?.item as Item;
    if (item.detail?.kind !== 'block') throw new Error('Not a Block');
    store.record(
      {
        type: 'update',
        itemId: block,
        changes: { detail: { ...item.detail, text: 'call with Leo Wednesday at 2' } },
      },
      user,
    );
    runner.trigger({ kind: 'typing', itemIds: [block] });
    await run();
    expect(calls).toHaveLength(2);
    expect(prompt()).toContain('call with Leo Wednesday at 2');
  });
});
