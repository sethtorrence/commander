import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActionContext,
  type AgentJobInfo,
  CONVERSATION_FOCUS_TIME,
  CONVERSATION_SCHEDULE,
  createSkillRegistry,
  type EventDetail,
  type FindTimeRequest,
  type FindTimeResult,
  type MeetingPrepDetail,
  PREPARE_MEETINGS,
  type ReadyReply,
  type SkillContext,
  SkillInputError,
  type SkillRegistry,
  type SourceItem,
  zonedTime,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EmailDraftFailed } from '../agent/draft-email-reply';
import { deliver } from '../agent/fixtures/emails';
import { SAM, TEAMS } from '../agent/fixtures/teams-chats';
import { workChats } from '../agent/fixtures/teams-work';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { createDraftSkill } from './draft';
import type { Findings } from './findings';
import { createMeetingPrepSkill } from './meeting-prep';
import { createScheduleSkill } from './schedule';

// Draft, Schedule and Meeting prep from a Conversation (#198), each run as a Conversation runs it
// (through the registry, with the refs handed out and what the choosing call read), on a real Item
// store and gate, with the clock and the time zone pinned (just after midnight in London, whatever the
// machine's own zone): what each is given, what it proposes or makes, and what Ares is told.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const user: ActionContext = { by: { kind: 'user' } };
const LONDON = 'Europe/London';
const ACCOUNT = 'google:104512345678901234567';
const PRIMARY = 'alex@gmail.test';
const at = (day: string, time: string) => zonedTime(day, time, LONDON);
// Tuesday 6 October 2026, five past midnight in London.
const NOW = at('2026-10-06', '00:05');
const LEO = 'leo.park@acme.test';
const BOOKING = 'https://calendar.app.google/BookAlex';

let dir: string;
let store: ItemStore;
let gate: Gate;
let skills: SkillRegistry;
let conversation: { conversationId: string; turnId: number };
let found: FindTimeRequest[];
let slots: { start: number; end: number }[];
let drafted: { kind: 'email' | 'chat'; itemId: string; instruction?: string }[];
let draftFails: Error | null;
let prepared: string[];
let jobs: AgentJobInfo[];

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

const idOf = (title: string) =>
  store.query({ kinds: ['event'] }).find((item) => item.title === title)?.id as string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-draft-schedule-prep-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => NOW,
  });
  gate = openGate({ itemStore: store });
  found = [];
  slots = [
    { start: at('2026-10-12', '09:00'), end: at('2026-10-12', '10:00') },
    { start: at('2026-10-13', '09:00'), end: at('2026-10-13', '10:00') },
    { start: at('2026-10-14', '11:30'), end: at('2026-10-14', '12:30') },
  ];
  drafted = [];
  draftFails = null;
  prepared = [];
  jobs = [
    {
      job: PREPARE_MEETINGS,
      name: 'Prepare for meetings',
      tier: 'deep',
      enabled: true,
      lastRunAt: null,
      lastOutcome: null,
      lastProblem: null,
    },
  ];
  skills = createSkillRegistry();
  const options = { itemStore: store, gate, now: () => NOW };
  skills.register(
    createScheduleSkill({
      ...options,
      timeZone: () => LONDON,
      findTime: async (request): Promise<FindTimeResult> => {
        found.push(request);
        return {
          slots,
          timeZone: LONDON,
          guests: request.attendees.map((email) => ({ email, checked: true, why: null, outside: false })),
          bookingLink: null,
        };
      },
    }),
  );
  skills.register(
    createDraftSkill({
      itemStore: store,
      draftEmail: async ({ itemId, instruction }): Promise<ReadyReply> => {
        if (draftFails) throw draftFails;
        drafted.push({ kind: 'email', itemId, ...(instruction !== undefined && { instruction }) });
        return {
          state: 'ready',
          answering: itemId,
          body: 'Hi Dana,\n\nThursday works.\n\nAlex',
          addedLinks: [],
          confidence: 0.9,
          sure: true,
          at: NOW,
        };
      },
      draftChat: async (itemId, instruction) => {
        drafted.push({ kind: 'chat', itemId, ...(instruction !== undefined && { instruction }) });
        return { itemId, text: 'Yes, I’ll send it Friday.', at: NOW };
      },
    }),
  );
  skills.register(
    createMeetingPrepSkill({
      itemStore: store,
      now: () => NOW,
      runner: {
        run: (job, itemIds) => {
          expect(job).toBe(PREPARE_MEETINGS);
          prepared.push(...(itemIds ?? []));
        },
        // "Prepare for meetings" writes its prep for each event it was asked about.
        async settled() {
          for (const eventId of prepared.splice(0)) {
            const detail: MeetingPrepDetail = {
              kind: 'meeting-prep',
              eventId,
              revision: 'r1',
              preparedAt: NOW,
              about: { text: 'The Acme renewal terms.', sources: [eventId] },
              lastTime: [],
              open: [],
              raise: [],
            };
            store.record(
              { type: 'create', item: { kind: 'meeting-prep', title: 'Prep', detail } },
              {
                by: { kind: 'ares' },
              },
            );
          }
        },
        jobs: () => jobs,
      },
    }),
  );
  store.calendars.listed(ACCOUNT, 'google-calendar', [
    { id: PRIMARY, name: PRIMARY, colour: '#9fe1e7', primary: true, accessRole: 'owner' },
  ]);
  store.saveFromSource({
    source: 'google-calendar',
    account: ACCOUNT,
    items: [
      // Last week's renewal call with Leo Park: how Commander knows his address.
      event('Acme renewal', at('2026-09-29', '15:00'), at('2026-09-29', '16:00'), {
        attendees: [guest(LEO, 'Leo Park')],
      }),
      // Today: board prep 15:00–16:00, and the 2pm with Leo.
      event('Board prep', at('2026-10-06', '15:00'), at('2026-10-06', '16:00')),
      event('Acme check-in', at('2026-10-06', '14:00'), at('2026-10-06', '14:30'), {
        attendees: [guest(LEO, 'Leo Park')],
      }),
      // Today: lunch alone.
      event('Lunch', at('2026-10-06', '12:00'), at('2026-10-06', '13:00')),
    ],
  });
  const { conversation: made } = store.conversations.create('2026-10-06');
  const asked = store.conversations.addUserTurn(made.id, 'Find an hour with Leo next week');
  const answer = store.conversations.startAnswer(made.id, asked.id, 'streaming');
  conversation = { conversationId: made.id, turnId: answer.id };
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// A Skill run from the Conversation: the refs handed out (I1, I2… in order), what the User said, and
// what the choosing call read from outside.
function run(
  skill: string,
  input: unknown,
  {
    handed = [],
    outside = [],
    asked = 'Find an hour with Leo next week',
  }: { handed?: string[]; outside?: string[]; asked?: string } = {},
): Promise<Findings> {
  const context: SkillContext = {
    conversation,
    asked,
    refs: new Map(handed.map((itemId, index) => [`I${index + 1}`, itemId])),
    read: { outside, background: null },
  };
  return skills.run(skill, input, context) as Promise<Findings>;
}

const proposal = (findings: Findings, index = 0) =>
  store.autonomy.proposal(findings.proposalIds?.[index] as number);
const eventStep = (findings: Findings) => {
  const step = proposal(findings)?.itemActions.find((each) => each.type === 'create-event');
  if (step?.type !== 'create-event') throw new Error('No event');
  return step.event;
};

function addTodo(title: string, status: 'open' | 'done' = 'open'): string {
  return store.record(
    {
      type: 'create',
      item: {
        kind: 'todo',
        title,
        status,
        detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null },
      },
    },
    user,
  ).itemId;
}

describe('Schedule: a meeting', () => {
  it('finds a time with the guests next week and prepares the event at the first one, waiting for the User', async () => {
    const findings = await run('schedule', {
      action: 'meeting',
      with: ['Leo'],
      minutes: 60,
      when: 'next-week',
    });
    // Leo's address comes from code (last week's event), and the span is next week on the User's clock.
    expect(found).toEqual([
      {
        attendees: [LEO],
        durationMinutes: 60,
        from: at('2026-10-12', '00:00'),
        to: at('2026-10-19', '00:00'),
      },
    ]);
    const record = proposal(findings);
    expect(record).toMatchObject({
      action: CONVERSATION_SCHEDULE,
      actionKind: 'act-for-you',
      section: 'calendar',
      status: 'pending',
      chained: false,
      conversation,
    });
    // On today's Daily Note (the meeting is about nothing in particular), with no Link to it.
    expect(store.get(record?.itemId as string)?.item.kind).toBe('daily-note');
    expect(record?.itemActions).toHaveLength(1);
    expect(eventStep(findings)).toMatchObject({
      kind: 'meeting',
      account: ACCOUNT,
      calendarId: PRIMARY,
      title: 'Meeting with Leo',
      start: { at: at('2026-10-12', '09:00') },
      end: { at: at('2026-10-12', '10:00') },
      attendees: [{ email: LEO, name: 'Leo Park' }],
    });
    // Commander's own note: when, how many guests, the other times, and whose calendars were checked.
    expect(findings.note).toContain('Waiting for the User to confirm: put the meeting you asked for');
    expect(findings.note).toContain('Monday 12 October, 09:00–10:00, with 1 guest invited');
    expect(findings.note).toContain(
      'Other times everyone is free: Tuesday 13 October, 09:00–10:00; Wednesday 14 October, 11:30–12:30.',
    );
    expect(findings.note).toContain('1 guest’s calendar was checked.');
    expect(findings.note).not.toContain('Leo');
  });

  it('looks in the next five working days when no time was said, and says when nobody is free', async () => {
    slots = [];
    const findings = await run('schedule', { action: 'meeting', with: ['Leo'] });
    expect(found[0]).toMatchObject({ durationMinutes: 30, from: NOW, to: at('2026-10-13', '00:00') });
    expect(findings.proposalIds).toEqual([]);
    expect(findings.note).toContain(
      'Not done: setting up the meeting: there is no time everyone is free for 30 minutes in the next 5 working days.',
    );
  });

  it('takes a time the User named on their own clock, and says what it clashes with without naming it', async () => {
    const findings = await run('schedule', {
      action: 'meeting',
      title: 'Call with Leo',
      with: ['Leo'],
      at: '2026-10-06T15:30',
    });
    expect(found).toEqual([]);
    expect(eventStep(findings)).toMatchObject({
      title: 'Call with Leo',
      start: { at: at('2026-10-06', '15:30') },
      end: { at: at('2026-10-06', '16:00') },
    });
    expect(findings.note).toContain('At that time the User already has 1 event in their calendar.');
    expect(findings.note).not.toContain('Board prep');
  });

  it('refuses a time already past, and a name nobody can place goes without an address', async () => {
    const past = await run('schedule', { action: 'meeting', with: ['Leo'], at: '2026-10-05T10:00' });
    expect(past.proposalIds).toEqual([]);
    expect(past.note).toContain('that time has already passed');

    const findings = await run('schedule', { action: 'meeting', with: ['Leo', 'Zed'], when: 'friday' });
    expect(found.at(-1)).toMatchObject({
      attendees: [LEO],
      from: at('2026-10-09', '00:00'),
      to: at('2026-10-10', '00:00'),
    });
    expect(eventStep(findings).attendees).toEqual([{ email: LEO, name: 'Leo Park' }]);
    expect(findings.note).toContain('1 person you named matches no address Commander knows');
  });

  it('an address only from outside words is never invited', async () => {
    const findings = await run('schedule', { action: 'meeting', with: ['mallory@evil.test'] });
    expect(found[0]?.attendees).toEqual([]);
    expect(eventStep(findings).attendees).toEqual([]);
    // In the User's own words, it is.
    const asked = await run(
      'schedule',
      { action: 'meeting', with: ['sam@partner.test'] },
      { asked: 'Set up a call with sam@partner.test' },
    );
    expect(eventStep(asked).attendees).toEqual([{ email: 'sam@partner.test', name: null }]);
  });

  it('about an email it read from outside: made from the email, and chained (always asks, with its cause)', async () => {
    const ids = deliver(store, NOW, [{ id: 'leo', subject: 'Renewal call', text: 'Can we talk next week?' }]);
    const email = ids.leo as string;
    const findings = await run(
      'schedule',
      { action: 'meeting', with: ['Leo'], from: 'I1', when: 'next-week' },
      { handed: [email], outside: [email] },
    );
    const record = proposal(findings);
    expect(record).toMatchObject({
      itemId: email,
      causedBy: { itemId: email },
      chained: true,
      status: 'pending',
    });
    expect(record?.itemActions[1]).toMatchObject({ type: 'link', linkType: 'made-from', to: email });
  });

  it('says so when there is no calendar to put events in', async () => {
    store.calendars.listed(ACCOUNT, 'google-calendar', [
      { id: PRIMARY, name: PRIMARY, colour: '#9fe1e7', primary: true, accessRole: 'reader' },
    ]);
    const findings = await run('schedule', { action: 'meeting', with: ['Leo'] });
    expect(findings.proposalIds).toEqual([]);
    expect(findings.note).toContain('there is no calendar to put events in');
  });

  it('refuses input that doesn’t fit before anything runs', async () => {
    await expect(run('schedule', { action: 'meeting', with: [] })).rejects.toThrow(SkillInputError);
    await expect(run('schedule', { action: 'meeting', with: ['Leo'], when: 'someday' })).rejects.toThrow(
      SkillInputError,
    );
    await expect(
      run('schedule', { action: 'meeting', with: ['Leo'], at: '2026-10-06 25:00' }),
    ).rejects.toThrow(SkillInputError);
    await expect(run('schedule', { action: 'meeting', with: ['Leo'], from: 'E1' })).rejects.toThrow(
      SkillInputError,
    );
    expect(found).toEqual([]);
  });
});

describe('Schedule: focus time', () => {
  it('blocks the first free time for a Todo in the Commander calendar, Tidy your Sources, asking by default', async () => {
    const todo = addTodo('Acme deck');
    const findings = await run(
      'schedule',
      { action: 'focus', todo: 'I1', minutes: 120 },
      { handed: [todo], asked: 'Block two hours for the Acme Todo' },
    );
    const record = proposal(findings);
    expect(record).toMatchObject({
      itemId: todo,
      action: CONVERSATION_FOCUS_TIME,
      actionKind: 'tidy-sources',
      section: 'calendar',
      status: 'pending',
      chained: false,
    });
    // Today from 09:00: the first two free hours inside working hours.
    expect(eventStep(findings)).toMatchObject({
      kind: 'focus-block',
      account: ACCOUNT,
      title: 'Focus: Acme deck',
      start: { at: at('2026-10-06', '09:00') },
      end: { at: at('2026-10-06', '11:00') },
    });
    expect(record?.itemActions[1]).toMatchObject({ type: 'link', linkType: 'made-from', to: todo });
    expect(findings.note).toContain(
      'block 120 minutes of focus time for I1 in the User’s Commander calendar, Tuesday 6 October, 09:00–11:00',
    );

    // A second block doesn't take the time the first still waits on: today's next two free hours.
    const again = await run('schedule', { action: 'focus', title: 'Writing', minutes: 120, when: 'today' });
    expect(eventStep(again)).toMatchObject({
      title: 'Focus: Writing',
      start: { at: at('2026-10-06', '16:00') },
      end: { at: at('2026-10-06', '18:00') },
    });
  });

  it('goes ahead when the User’s settings let it, with Undo', async () => {
    gate.setLevel({ scope: 'action', action: CONVERSATION_FOCUS_TIME }, 'auto');
    const findings = await run('schedule', { action: 'focus', minutes: 60, when: 'tomorrow' });
    expect(proposal(findings)?.status).toBe('done');
    expect(findings.note).toContain('Done: block 60 minutes of focus time in the User’s Commander calendar');
    const focus = store.query({ kinds: ['event'] }).find((item) => item.title === 'Focus time');
    expect(focus?.detail).toMatchObject({ start: { at: at('2026-10-07', '09:00') }, private: true });
  });

  it('a Todo already done, or something that isn’t a Todo, gets none', async () => {
    const done = addTodo('Old deck', 'done');
    expect(
      (await run('schedule', { action: 'focus', todo: 'I1', minutes: 60 }, { handed: [done] })).note,
    ).toContain('I1 is already done');
    const lunch = idOf('Lunch');
    expect(
      (await run('schedule', { action: 'focus', todo: 'I1', minutes: 60 }, { handed: [lunch] })).note,
    ).toContain('I1 isn’t a Todo');
  });
});

describe('Schedule: the booking link', () => {
  it('makes a reply holding the link for the User to open, and proposes nothing', async () => {
    const ids = deliver(store, NOW, [{ id: 'leo', subject: 'Catch up?', text: 'When suits you?' }]);
    const email = ids.leo as string;
    const none = await run('schedule', { action: 'booking-link', to: 'I1' }, { handed: [email] });
    expect(none.note).toContain('the User hasn’t saved one');
    expect(none.made).toBeUndefined();

    store.schedulingSettings.save({ bookingLink: BOOKING });
    const findings = await run('schedule', { action: 'booking-link', to: 'I1' }, { handed: [email] });
    expect(findings.proposalIds).toEqual([]);
    expect(findings.made).toEqual([
      {
        kind: 'booking-reply',
        itemId: email,
        title: 'Catch up?',
        to: 'email',
        text: `Book a time here: ${BOOKING}`,
        link: BOOKING,
      },
    ]);
    expect(findings.note).toContain('Nothing has been sent');
    expect(gate.activity({})).toEqual([]);
  });
});

describe('Draft', () => {
  it('drafts an email reply with the User’s own message as what it should say, and shows it, unsent', async () => {
    const ids = deliver(store, NOW, [{ id: 'dana', subject: 'Q4 offsite', text: 'Which dates work?' }]);
    const email = ids.dana as string;
    const findings = await run(
      'draft',
      { item: 'I1' },
      { handed: [email], asked: 'Reply to this saying Thursday works' },
    );
    expect(drafted).toEqual([
      { kind: 'email', itemId: email, instruction: 'Reply to this saying Thursday works' },
    ]);
    expect(findings.made).toEqual([
      {
        kind: 'email-draft',
        itemId: email,
        title: 'Q4 offsite',
        body: 'Hi Dana,\n\nThursday works.\n\nAlex',
        addedLinks: [],
        sure: true,
      },
    ]);
    expect(findings.proposalIds).toBeUndefined();
    expect(findings.note).toContain('It hasn’t been sent, and nothing is sent from a Conversation');
    // Never the draft's words in what Ares is told.
    expect(findings.note).not.toContain('Thursday');
    expect(gate.activity({})).toEqual([]);
  });

  it('drafts a Chat reply for its reply box', async () => {
    store.saveFromSource({
      source: 'teams',
      account: TEAMS,
      me: SAM.userId,
      items: [workChats(NOW).omar],
      deleted: [],
    });
    const chat = store.query({ kinds: ['chat'] })[0];
    const findings = await run(
      'draft',
      { item: 'I1' },
      { handed: [chat?.id as string], asked: 'Tell Omar yes' },
    );
    expect(drafted).toEqual([{ kind: 'chat', itemId: chat?.id, instruction: 'Tell Omar yes' }]);
    expect(findings.made).toEqual([
      { kind: 'chat-draft', itemId: chat?.id, title: chat?.title, text: 'Yes, I’ll send it Friday.' },
    ]);
  });

  it('says plainly why not, and refuses a ref it wasn’t given', async () => {
    const todo = addTodo('Send the deck');
    expect((await run('draft', { item: 'I1' }, { handed: [todo] })).note).toContain(
      'Not done: drafting a reply to I1: it isn’t an email or a Teams Chat',
    );
    const ids = deliver(store, NOW, [{ id: 'dana', subject: 'Q4 offsite', text: 'Which dates work?' }]);
    draftFails = new EmailDraftFailed('Drafting replies is Off in Settings → Autonomy');
    expect((await run('draft', { item: 'I1' }, { handed: [ids.dana as string] })).note).toContain(
      'Not done: drafting a reply to I1: Drafting replies is Off in Settings → Autonomy.',
    );
    await expect(run('draft', { item: 'I2' }, { handed: [todo] })).rejects.toThrow(SkillInputError);
    expect(drafted).toEqual([]);
  });
});

describe('Meeting prep', () => {
  it('prepares the meeting the User named and shows its prep, linked to the event', async () => {
    const meeting = idOf('Acme check-in');
    const findings = await run('prep', { event: 'I1' }, { handed: [meeting], asked: 'Prep me for the 2pm' });
    expect(findings.made).toEqual([
      { kind: 'meeting-prep', eventId: meeting, title: 'Acme check-in', startsAt: at('2026-10-06', '14:00') },
    ]);
    // Its lines go back to Ares as background, never as his own instructions.
    expect(findings.more).toEqual([
      expect.objectContaining({ label: 'Meeting prep for I1', text: '- The Acme renewal terms.' }),
    ]);
    expect(findings.note).toContain('the prep for I1 is ready and shows under your answer');
  });

  it('a meeting with no one else in it, or a prep switched off, is said plainly', async () => {
    const lunch = idOf('Lunch');
    expect((await run('prep', { event: 'I1' }, { handed: [lunch] })).note).toContain(
      'no one else is in it, so there is nothing to prepare',
    );
    jobs = jobs.map((job) => ({ ...job, enabled: false }));
    expect((await run('prep', { event: 'I1' }, { handed: [idOf('Acme check-in')] })).note).toContain(
      'Prepare for meetings is switched off in Settings → Ares',
    );
    expect(prepared).toEqual([]);
  });
});
