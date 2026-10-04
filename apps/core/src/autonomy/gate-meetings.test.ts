import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, Proposal } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { type Gate, openGate } from './gate';

// Proposals that make a meeting (#132): an event with guests is seen by other people, so it is Act for
// you and only ever a suggestion (#11), accepted one at a time with its full detail; time held for the
// User alone is Tidy your Sources. The User may change the event on the card (its time, guests,
// Account and calendar) before Create, which accepts the suggestion with those changes, as the User.

const user: ActionContext = { by: { kind: 'user' } };
const ALEX = 'google:104512345678901234567';
const WORK = 'google:work';
const START = Date.UTC(2026, 9, 6, 13);
const HALF = 30 * 60_000;

let dir: string;
let store: ItemStore;
let gate: Gate;
let block: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-gate-meetings-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => Date.UTC(2026, 9, 5, 7),
  });
  store.calendars.listed(ALEX, 'google-calendar', [
    { id: 'alex@gmail.test', name: 'alex@gmail.test', colour: '#9fe1e7', primary: true, accessRole: 'owner' },
  ]);
  store.calendars.listed(WORK, 'google-calendar', [
    {
      id: 'alex@titanlink.test',
      name: 'alex@titanlink.test',
      colour: '#33b679',
      primary: true,
      accessRole: 'owner',
    },
    {
      id: 'c_team@group.calendar.google.com',
      name: 'Team',
      colour: '#aaaaaa',
      primary: false,
      accessRole: 'writer',
    },
  ]);
  gate = openGate({ itemStore: store });
  gate.registerAction({
    action: 'create-events-with-guests',
    actionKind: 'act-for-you',
    name: 'Create events with guests',
  });
  gate.registerAction({ action: 'hold-time', actionKind: 'tidy-sources', name: 'Hold time for yourself' });
  const note = store.ensureDailyNote('2026-10-05', user);
  block = store.record(
    {
      type: 'create',
      item: {
        kind: 'block',
        title: 'call with Leo Tuesday at 2',
        detail: {
          kind: 'block',
          dailyNoteId: note.id,
          parentId: null,
          position: 'a0',
          text: 'call with Leo Tuesday at 2',
          folded: false,
        },
      },
    },
    user,
  ).itemId;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const time = (at: number) => ({ at, timeZone: 'Europe/London', date: null });

function meeting(
  overrides: Partial<Proposal> = {},
  attendees = [{ email: 'leo.park@acme.test', name: 'Leo Park' }],
): Proposal {
  return {
    actionKind: 'act-for-you',
    action: 'create-events-with-guests',
    section: 'calendar',
    itemId: block,
    itemActions: [
      {
        type: 'create-event',
        event: {
          kind: 'meeting',
          account: ALEX,
          title: 'Call with Leo',
          start: time(START),
          end: time(START + HALF),
          attendees,
        },
      },
      { type: 'link', from: { step: 0 }, linkType: 'made-from', to: block },
    ],
    confidence: 0.95,
    reason: 'You wrote “call with Leo Tuesday at 2”. You’re free then.',
    ...overrides,
  };
}

const eventOf = (entryIds: number[]) => store.get(store.entry(entryIds[0] as number)?.itemId as string);

describe('a proposed meeting', () => {
  it('is always a suggestion, even with Act for you set to Auto for the action', () => {
    expect(() => gate.setLevel({ scope: 'action', action: 'create-events-with-guests' }, 'auto')).toThrow(
      /can’t go above Ask/,
    );
    const outcome = gate.propose(meeting());
    expect(outcome.decision).toBe('ask');
    expect(store.query({ kinds: ['event'] })).toEqual([]);
  });

  it('with guests can’t be passed off as time held for the User alone', () => {
    expect(() => gate.propose(meeting({ actionKind: 'tidy-sources', action: 'hold-time' }))).toThrow(
      /invites guests, which is Act for you/,
    );
    // With no guests it may be.
    gate.setLevel({ scope: 'action', action: 'hold-time' }, 'auto');
    const held = gate.propose(meeting({ actionKind: 'tidy-sources', action: 'hold-time' }, []));
    expect(held.decision).toBe('auto');
  });

  it('is accepted one at a time, never in bulk', () => {
    const outcome = gate.propose(meeting());
    if (outcome.decision !== 'ask') throw new Error('Wanted a suggestion');
    expect(() => gate.acceptAll([outcome.suggestion.id])).toThrow(/one at a time/);
  });

  it('accepted as it is, makes the event with its guests, Linked: made from the Block', () => {
    const outcome = gate.propose(meeting());
    if (outcome.decision !== 'ask') throw new Error('Wanted a suggestion');
    const accepted = gate.accept(outcome.suggestion.id);
    const event = eventOf(accepted.entryIds);
    expect(event?.item).toMatchObject({ kind: 'event', title: 'Call with Leo', account: ALEX });
    expect(event?.item.detail).toMatchObject({
      createdByCommander: 'meeting',
      attendees: [{ email: 'leo.park@acme.test' }],
    });
    expect(event?.links).toMatchObject([{ type: 'made-from', to: { id: block } }]);
    expect(store.entry(accepted.entryIds[0] as number)?.by).toEqual({ kind: 'user' });
  });

  it('accepted with the User’s changes from the card, makes the event as changed', () => {
    const outcome = gate.propose(meeting());
    if (outcome.decision !== 'ask') throw new Error('Wanted a suggestion');
    const accepted = gate.accept(outcome.suggestion.id, {
      event: {
        account: WORK,
        calendarId: 'c_team@group.calendar.google.com',
        title: 'Acme renewal call',
        start: time(START + 2 * HALF),
        end: time(START + 4 * HALF),
        attendees: [
          { email: 'leo.park@acme.test', name: 'Leo Park' },
          { email: 'dana@titanlink.test', name: null },
        ],
      },
    });
    const event = eventOf(accepted.entryIds);
    expect(event?.item).toMatchObject({ account: WORK, title: 'Acme renewal call' });
    expect(event?.item.detail).toMatchObject({
      calendar: { id: 'c_team@group.calendar.google.com' },
      start: { at: START + 2 * HALF },
      end: { at: START + 4 * HALF },
      attendees: [{ email: 'leo.park@acme.test' }, { email: 'dana@titanlink.test' }],
    });
    expect(event?.links).toMatchObject([{ type: 'made-from', to: { id: block } }]);
  });

  it('takes changes only for a suggestion that makes an event', () => {
    gate.registerAction({ action: 'suggest-todos', actionKind: 'organise', name: 'Suggest Todos' });
    const outcome = gate.propose({
      actionKind: 'organise',
      action: 'suggest-todos',
      section: 'notes',
      itemId: block,
      itemActions: [
        {
          type: 'create',
          item: {
            kind: 'todo',
            title: 'Call Leo',
            detail: { kind: 'todo', origin: 'ares', dueOn: null, backedBy: null },
          },
        },
      ],
      confidence: 0.5,
      reason: 'You wrote it.',
    });
    if (outcome.decision !== 'ask') throw new Error('Wanted a suggestion');
    expect(() => gate.accept(outcome.suggestion.id, { event: { title: 'Nope' } })).toThrow(/makes no event/);
  });
});
