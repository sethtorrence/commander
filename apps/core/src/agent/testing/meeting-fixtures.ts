// Fixtures for the meeting prep tests (#130): calendar events, Linear issues and the notes under past
// meetings' chips, saved through a real Item store the way sync and the window would save them.
import {
  type ActionContext,
  blockLinkToken,
  type EventAttendee,
  type EventDetail,
  type Item,
  type SourceItem,
} from '@commander/domain';
import type { ItemStore } from '../../item-store';

export const ME = 'alex@acme.test';
export const PRIYA = 'priya@acme.test';
export const DANA = 'dana@acme.test';
export const CALENDAR_ACCOUNT = 'google:1';

const user: ActionContext = { by: { kind: 'user' } };

export const attendee = (email: string, extra: Partial<EventAttendee> = {}): EventAttendee => ({
  email,
  name: email === PRIYA ? 'Priya Patel' : email === DANA ? 'Dana Kim' : null,
  self: email === ME,
  response: 'accepted',
  organiser: false,
  optional: false,
  resource: false,
  ...extra,
});

/** A timed event the User organises, with Priya in it unless the guests are given. */
export function eventItem(
  id: string,
  title: string,
  start: number,
  extra: Partial<EventDetail> = {},
  minutes = 30,
): SourceItem {
  const attendees = extra.attendees ?? [attendee(ME, { organiser: true }), attendee(PRIYA)];
  return {
    externalId: id,
    kind: 'event',
    title,
    people: attendees.map((each) => each.email),
    detail: {
      kind: 'event',
      calendar: { id: 'primary', name: 'Primary', colour: '#9fe1e7' },
      accountEmail: ME,
      start: { at: start, timeZone: null, date: null },
      end: { at: start + minutes * 60_000, timeZone: null, date: null },
      allDay: false,
      location: null,
      description: null,
      organiser: { email: ME, name: 'Alex', self: true },
      attendees,
      myResponse: 'accepted',
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

/** Saves events as calendar sync would; returns their Item ids, in order. */
export function syncEvents(store: ItemStore, events: SourceItem[]): string[] {
  store.saveFromSource({ source: 'google-calendar', account: CALENDAR_ACCOUNT, items: events });
  return events.map((event) => idOf(store, 'google-calendar', CALENDAR_ACCOUNT, event.externalId));
}

export function idOf(
  store: ItemStore,
  source: 'google-calendar' | 'linear',
  account: string,
  externalId: string,
) {
  const [item] = store.fromSource({ source, account }, [externalId]);
  if (!item) throw new Error(`No ${source} Item ${externalId}`);
  return item.id;
}

/** Linear issues involving these people (by email), as Linear sync saves them; returns their ids. */
export function syncIssues(
  store: ItemStore,
  issues: { id: string; title: string; people: string[]; status?: 'open' | 'done'; description?: string }[],
): string[] {
  store.saveFromSource({
    source: 'linear',
    account: 'linear:1',
    items: issues.map((issue, index) => ({
      externalId: issue.id,
      kind: 'linear-issue',
      title: issue.title,
      people: issue.people,
      status: issue.status ?? 'open',
      detail: {
        kind: 'linear-issue',
        identifier: `ENG-${index + 1}`,
        url: `https://linear.app/acme/issue/ENG-${index + 1}`,
        team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
        state:
          issue.status === 'done'
            ? { id: 'd', name: 'Done', type: 'completed', color: '#5e6ad2' }
            : { id: 's', name: 'In Progress', type: 'started', color: '#f2c94c' },
        priority: 2,
        assignee: null,
        creator: null,
        labels: [],
        linearProject: null,
        cycle: null,
        dueDate: null,
        estimate: null,
        description: issue.description ?? null,
        comments: [],
        createdAt: 0,
        updatedAt: 0,
        startedAt: null,
        completedAt: null,
        canceledAt: null,
      },
    })),
  });
  return issues.map((issue) => idOf(store, 'linear', 'linear:1', issue.id));
}

let positions = 0;
const nextPosition = () => `a${(positions++).toString(36).padStart(4, '0')}`;

/** A Block the User wrote in a day's Daily Note (under `parentId` when given); returns its id. */
export function writeBlock(
  store: ItemStore,
  day: string,
  text: string,
  parentId: string | null = null,
): string {
  const note = store.ensureDailyNote(day, user);
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
          position: nextPosition(),
          text,
          folded: false,
        },
      },
    },
    user,
  ).itemId;
}

/** A meeting chip for an event in a day's Daily Note, with the User's notes under it; returns the chip's id. */
export function chipWithNotes(store: ItemStore, day: string, eventId: string, notes: string[]): string {
  const chip = writeBlock(store, day, blockLinkToken({ type: 'event', eventId }));
  for (const text of notes) writeBlock(store, day, text, chip);
  return chip;
}

export const itemOf = (store: ItemStore, id: string): Item => {
  const item = store.get(id)?.item;
  if (!item) throw new Error(`No Item ${id}`);
  return item;
};
