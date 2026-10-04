import type { EventDetail, Item, Project } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { chipLabel, insertLink, linkQueryAt, removeLinkAt, splitLinks } from './block-text';

const P = '0b6c5f7e-2f9a-4b8e-9d1c-3a4b5c6d7e8f';
const LT = `[[project:${P}]]`;
const longtail: Project = {
  id: P,
  name: 'Longtail',
  code: 'LT',
  accent: 'blue',
  order: 0,
  archived: false,
  createdAt: 0,
};

describe('the [[ being typed', () => {
  it('is found from the [[ to the caret', () => {
    expect(linkQueryAt('Call [[thu', 10)).toEqual({ start: 5, query: 'thu' });
    expect(linkQueryAt('[[', 2)).toEqual({ start: 0, query: '' });
    expect(linkQueryAt('a [[long tail', 13)).toEqual({ start: 2, query: 'long tail' });
  });

  it('is not there without a [[, after a finished token, or across brackets', () => {
    expect(linkQueryAt('Call thu', 8)).toBeNull();
    expect(linkQueryAt('[[2026-10-01]] and', 18)).toBeNull();
    expect(linkQueryAt('[[2026-10-01]]', 14)).toBeNull();
    expect(linkQueryAt('[[a]b', 5)).toBeNull();
    expect(linkQueryAt('[[thu', 2)).toEqual({ start: 0, query: '' });
  });
});

describe('choosing a target', () => {
  it('puts the token where the [[ and the query were, and the caret after it', () => {
    expect(
      insertLink('Call [[thu about it', { start: 5, query: 'thu' }, { type: 'day', day: '2026-10-01' }),
    ).toEqual({
      text: 'Call [[2026-10-01]] about it',
      caret: 19,
    });
  });
});

describe('deleting a chip', () => {
  const text = `See ${LT} today`;
  const end = 4 + LT.length;

  it('takes the whole token with Backspace just after it, or Delete just before it', () => {
    expect(removeLinkAt(text, end, 'backward')).toEqual({ text: 'See  today', caret: 4 });
    expect(removeLinkAt(text, 4, 'forward')).toEqual({ text: 'See  today', caret: 4 });
  });

  it('leaves the text alone anywhere else', () => {
    expect(removeLinkAt(text, 3, 'backward')).toBeNull();
    expect(removeLinkAt(text, end, 'forward')).toBeNull();
  });
});

describe('a Block’s text in parts', () => {
  it('splits into text and links', () => {
    expect(splitLinks(`a [[2026-10-01]]${LT}b`)).toEqual([
      { text: 'a ' },
      { text: '[[2026-10-01]]', target: { type: 'day', day: '2026-10-01' } },
      { text: LT, target: { type: 'project', projectId: P } },
      { text: 'b' },
    ]);
    expect(splitLinks('')).toEqual([]);
  });
});

describe('a chip’s label', () => {
  const context = { today: '2026-10-03', projectById: (id: string) => (id === P ? longtail : undefined) };

  it('names a day as it reads, and says where it goes', () => {
    expect(chipLabel({ type: 'day', day: '2026-10-01' }, context)).toEqual({
      text: 'Thu 1 Oct',
      title: 'Thursday 1 October 2026: go to its Daily Note',
    });
  });

  it('names a Project with its Badge, or says it is unknown', () => {
    expect(chipLabel({ type: 'project', projectId: P }, context)).toEqual({
      text: 'Longtail',
      title: 'Longtail: open its Project page',
      project: longtail,
    });
    expect(chipLabel({ type: 'project', projectId: 'gone' }, context)).toEqual({
      text: 'Unknown Project',
      title: 'This Project no longer exists',
    });
  });
});

describe('a meeting chip’s label: the event’s live card', () => {
  const at = (hour: number, minute = 0, date = 3) => new Date(2026, 9, date, hour, minute).getTime();
  const sync: Item = {
    id: 'e-sync',
    kind: 'event',
    source: 'google-calendar',
    account: 'google:1',
    externalId: 'sync',
    title: 'Weekly sync with Priya',
    people: [],
    filing: { projectId: P, filedBy: 'user' },
    status: 'open',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    detail: {
      kind: 'event',
      calendar: { id: 'primary', name: 'Primary', colour: '#33b679' },
      accountEmail: null,
      start: { at: at(10), timeZone: null, date: null },
      end: { at: at(10, 30), timeZone: null, date: null },
      allDay: false,
      location: null,
      description: null,
      organiser: null,
      attendees: [],
      myResponse: null,
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      busy: true,
      private: false,
      seriesId: null,
      webUrl: null,
      createdByCommander: null,
    },
  };
  const events = new Map([[sync.id, sync]]);
  const context = {
    today: '2026-10-03',
    projectById: (id: string) => (id === P ? longtail : undefined),
    eventById: (id: string) => events.get(id),
  };
  const target = { type: 'event' as const, eventId: sync.id };

  it('shows its times, title, calendar colour, meeting link and Badge', () => {
    expect(chipLabel(target, context)).toEqual({
      text: '10:00–10:30 Weekly sync with Priya',
      title: 'Weekly sync with Priya, 10:00–10:30 on Primary: open it in the Calendar Section',
      project: longtail,
      meeting: {
        colour: '#33b679',
        joinUrl: 'https://meet.google.com/abc-defg-hij',
        status: null,
        struck: false,
      },
    });
  });

  it('says when it was cancelled, declined or moved, from the day of its note', () => {
    events.set(sync.id, { ...sync, deletedAt: at(9) });
    expect(chipLabel(target, context).meeting).toMatchObject({
      status: 'Cancelled',
      struck: true,
      joinUrl: null,
    });
    const moved = {
      ...sync,
      detail: { ...(sync.detail as EventDetail), start: { at: at(10, 0, 8), timeZone: null, date: null } },
    };
    events.set(sync.id, moved);
    expect(chipLabel(target, context).meeting).toMatchObject({ status: 'Moved to Thu 10:00', struck: false });
    expect(chipLabel(target, context, { day: '2026-10-08' }).meeting?.status).toBeNull();
    events.delete(sync.id);
    expect(chipLabel(target, context)).toMatchObject({ text: 'A meeting', meeting: { struck: false } });
  });
});

describe('an email chip’s label: the email’s live card', () => {
  const budget: Item = {
    id: 'm-budget',
    kind: 'email',
    source: 'gmail',
    account: 'google:alex',
    externalId: 'budget',
    title: 'Q4 budget',
    people: [],
    filing: { projectId: P, filedBy: 'user' },
    status: 'open',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    detail: {
      kind: 'email',
      messageId: null,
      inReplyTo: null,
      references: [],
      threadKey: 't-budget',
      sourceThreadId: null,
      from: { name: 'Dana Whitfield', address: 'dana@northwind.test' },
      to: [],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: 'Q4 budget',
      sentAt: new Date(2026, 9, 1, 9, 5).getTime(),
      snippet: '',
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
  };
  const emails = new Map([[budget.id, budget]]);
  const context = {
    today: '2026-10-03',
    projectById: (id: string) => (id === P ? longtail : undefined),
    emailById: (id: string) => emails.get(id),
  };
  const target = { type: 'email' as const, emailId: budget.id };

  it('shows its sender, subject, date and Badge', () => {
    expect(chipLabel(target, context)).toEqual({
      text: 'Q4 budget',
      title: 'Q4 budget, from Dana Whitfield on 1 Oct: open its thread in the Email Section',
      project: longtail,
      email: { sender: 'Dana Whitfield', date: '1 Oct', gone: false },
    });
  });

  it('says it is gone when Commander no longer has it', () => {
    emails.set(budget.id, { ...budget, deletedAt: 1 });
    expect(chipLabel(target, context)).toMatchObject({
      text: 'Q4 budget',
      email: { sender: 'Dana Whitfield', gone: true },
    });
    emails.delete(budget.id);
    expect(chipLabel(target, context)).toEqual({
      text: 'An email',
      title: 'An email Commander doesn’t have',
      email: { sender: '', date: '', gone: true },
    });
  });
});
