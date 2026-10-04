import {
  type ChatDetail,
  type ChatMessage,
  chatFlags,
  type EventDetail,
  type Item,
  type LinearIssueDetail,
  type Ranking,
} from '@commander/domain';
import { describe, expect, it } from 'vitest';
import {
  bandCounts,
  type Clears,
  clearRow,
  type FeedRow,
  feedRows,
  keepClears,
  rowMeta,
  sourceTag,
  tabCount,
} from './feed';

const NOW = new Date(2026, 9, 1, 11, 40).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function todo(id: string, dueOn: string | null = null, rest: Partial<Item> = {}): Item {
  return {
    id,
    kind: 'todo',
    source: null,
    account: null,
    externalId: null,
    title: `Todo ${id}`,
    people: [],
    filing: null,
    status: 'open',
    detail: { kind: 'todo', origin: 'manual', dueOn, backedBy: null },
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    deletedAt: null,
    ...rest,
  };
}

function issue(id: string, detail: Partial<LinearIssueDetail> = {}): Item {
  return {
    ...todo(id),
    kind: 'linear-issue',
    source: 'linear',
    account: 'linear:acme',
    detail: {
      kind: 'linear-issue',
      identifier: id,
      url: '',
      team: { id: 't', key: 'ENG', name: 'Engineering' },
      state: { id: 's', name: 'In Progress', type: 'started', color: '' },
      priority: 0,
      assignee: null,
      creator: null,
      labels: [],
      cycle: null,
      linearProject: null,
      dueDate: null,
      estimate: null,
      description: null,
      comments: [],
      createdAt: NOW - DAY,
      updatedAt: NOW - 3 * HOUR,
      startedAt: null,
      completedAt: null,
      canceledAt: null,
      ...detail,
    },
  };
}

const ranking = (itemId: string, band: Ranking['band'], rank = 1): Ranking => ({
  itemId,
  band,
  reason: `${band} reason`,
  rank,
});

describe('the rows on the Dashboard', () => {
  it('pairs each ranking with its Item, in the ranked order', () => {
    const items = [todo('a'), todo('b')];
    const rows = feedRows([ranking('b', 'now'), ranking('a', 'today')], items, {}, new Map());
    expect(rows.map((row) => [row.item.id, row.band, row.reason, row.done])).toEqual([
      ['b', 'now', 'now reason', false],
      ['a', 'today', 'today reason', false],
    ]);
  });

  it('leaves out cleared rows while they stay in the band they were cleared from', () => {
    const items = [todo('a'), todo('b')];
    const clears: Clears = { a: { band: 'now', at: NOW } };
    const rows = feedRows([ranking('a', 'now'), ranking('b', 'now', 2)], items, clears, new Map());
    expect(rows.map((row) => row.item.id)).toEqual(['b']);
  });

  it('shows a cleared row again once its band changes', () => {
    const clears: Clears = { a: { band: 'today', at: NOW } };
    const rows = feedRows([ranking('a', 'now')], [todo('a')], clears, new Map());
    expect(rows.map((row) => row.item.id)).toEqual(['a']);
  });

  it('keeps a row ticked here, done and in its place, until the Dashboard is left', () => {
    const ticked: FeedRow = {
      item: { ...todo('a'), status: 'done' },
      band: 'now',
      reason: 'Overdue',
      rank: 1,
      done: true,
    };
    const rows = feedRows([ranking('b', 'now', 1)], [todo('b')], {}, new Map([['a', ticked]]));
    expect(rows.map((row) => [row.item.id, row.done])).toEqual([
      ['a', true],
      ['b', false],
    ]);
  });

  it('shows a row ticked here and unticked again as ranked, once', () => {
    const ticked: FeedRow = { item: todo('a'), band: 'now', reason: 'Overdue', rank: 1, done: true };
    const rows = feedRows([ranking('a', 'today')], [todo('a')], {}, new Map([['a', ticked]]));
    expect(rows.map((row) => [row.item.id, row.band, row.done])).toEqual([['a', 'today', false]]);
  });

  it('skips a ranking whose Item it doesn’t have', () => {
    expect(feedRows([ranking('gone', 'now')], [], {}, new Map())).toEqual([]);
  });
});

describe('clearing', () => {
  it('remembers the band a row was cleared from', () => {
    const row: FeedRow = { item: todo('a'), band: 'waiting', reason: '', rank: 1, done: false };
    expect(clearRow({}, row, NOW)).toEqual({ a: { band: 'waiting', at: NOW } });
  });

  it('forgets a clear once its Item is ranked into another band', () => {
    const clears: Clears = { a: { band: 'today', at: NOW }, b: { band: 'now', at: NOW } };
    expect(keepClears(clears, [ranking('a', 'now'), ranking('b', 'now')], NOW)).toEqual({
      b: { band: 'now', at: NOW },
    });
  });

  it('keeps a clear while its Item is off the Dashboard, and forgets it after 30 days', () => {
    const clears: Clears = {
      fresh: { band: 'now', at: NOW - DAY },
      old: { band: 'now', at: NOW - 31 * DAY },
    };
    expect(keepClears(clears, [], NOW)).toEqual({ fresh: { band: 'now', at: NOW - DAY } });
  });

  it('returns the same clears when nothing is forgotten, so nothing is saved again', () => {
    const clears: Clears = { a: { band: 'now', at: NOW } };
    expect(keepClears(clears, [ranking('a', 'now')], NOW)).toBe(clears);
  });
});

describe('counts', () => {
  const row = (id: string, band: Ranking['band'], done = false): FeedRow => ({
    item: todo(id),
    band,
    reason: '',
    rank: 1,
    done,
  });

  it('counts the open rows in each band', () => {
    const rows = [row('a', 'now'), row('b', 'now'), row('c', 'today', true), row('d', 'fyi')];
    expect(bandCounts(rows)).toEqual({ now: 2, today: 0, waiting: 0, fyi: 1 });
  });

  it('puts the open rows in Now and Today on the tab', () => {
    const rows = [
      row('a', 'now'),
      row('b', 'today'),
      row('c', 'today', true),
      row('d', 'waiting'),
      row('e', 'fyi'),
    ];
    expect(tabCount(rows)).toBe(2);
  });
});

describe('how a row is labelled', () => {
  it('stamps Commander’s own Todos TODO, and Linear issues LIN with their state', () => {
    expect(sourceTag(todo('a', '2026-10-02'))).toEqual({ stamp: 'TODO', text: 'Manual · due Fri' });
    expect(sourceTag(todo('b'))).toEqual({ stamp: 'TODO', text: 'Manual' });
    expect(sourceTag(issue('ENG-1'))).toEqual({ stamp: 'LIN', text: 'In Progress' });
  });

  it('says when a Todo is due, on the right', () => {
    const at = (item: Item, band: Ranking['band']) =>
      rowMeta({ item, band, reason: '', rank: 1, done: false }, NOW);
    expect(at(todo('a', '2026-09-28'), 'now')).toEqual(['3D', 'Overdue']);
    expect(at(todo('b', '2026-10-01'), 'today')).toEqual(['Today', 'Due']);
    expect(at(issue('ENG-1', { priority: 1 }), 'now')).toEqual(['Urgent', 'ENG']);
    expect(
      at(issue('ENG-2', { state: { id: 's', name: 'In Review', type: 'started', color: '' } }), 'waiting'),
    ).toEqual(['Rev', 'Reviewers']);
    expect(at(issue('ENG-3'), 'today')).toEqual(['ENG', 'In Progress']);
    expect(
      at(
        issue('ENG-4', {
          state: { id: 's', name: 'Todo', type: 'unstarted', color: '' },
          cycle: { id: 'c', number: 41, name: null, startsAt: 0, endsAt: NOW + DAY },
        }),
        'today',
      ),
    ).toEqual(['ENG', 'Cycle 41']);
    expect(at(issue('ENG-5'), 'fyi')).toEqual(['3H', 'Changed']);
  });
});

describe('a meeting on the Dashboard', () => {
  const start = NOW + 12 * 60_000;
  const sync: Item = {
    ...todo('sync'),
    kind: 'event',
    source: 'google-calendar',
    account: 'google:1',
    title: 'Weekly sync',
    detail: {
      kind: 'event',
      calendar: { id: 'c', name: 'Titanlink', colour: '#33b679' },
      accountEmail: null,
      start: { at: start, timeZone: null, date: null },
      end: { at: start + 30 * 60_000, timeZone: null, date: null },
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
    },
  };
  const row = { item: sync, band: 'now' as const, reason: '', rank: 1, done: false };

  it('is stamped CAL with its calendar', () => {
    expect(sourceTag(sync)).toEqual({ stamp: 'CAL', text: 'Titanlink · 11:52–12:22' });
  });

  it('says when it starts, then when it ends', () => {
    expect(rowMeta(row, NOW)).toEqual(['12M', 'Starts']);
    expect(rowMeta(row, start + 60_000)).toEqual(['Now', 'Ends 12:22']);
  });

  it('as an invitation waiting in Today, says which day it is and that it needs an answer', () => {
    const later = start + 3 * DAY;
    const invitation: Item = {
      ...sync,
      detail: {
        ...(sync.detail as EventDetail),
        start: { at: later, timeZone: null, date: null },
        end: { at: later + 30 * 60_000, timeZone: null, date: null },
        organiser: { email: 'dana@acme.test', name: 'Dana Reyes', self: false },
        myResponse: 'needs-action',
      },
    };
    const today = { item: invitation, band: 'today' as const, reason: '', rank: 1, done: false };
    expect(rowMeta(today, NOW)).toEqual([SHORT_DAY[new Date(later).getDay()], 'Invite']);
    expect(
      rowMeta(
        {
          ...today,
          item: {
            ...invitation,
            detail: {
              ...(sync.detail as EventDetail),
              organiser: { email: 'dana@acme.test', name: null, self: false },
              myResponse: 'needs-action',
            },
          },
        },
        NOW,
      ),
    ).toEqual(['Today', 'Invite']);
  });
});

describe('Chats on the Dashboard (#107)', () => {
  const TEAMS = 'teams:tenant:sam';
  const users = { [TEAMS]: 'u-sam' };
  const SAM = { userId: 'u-sam', name: 'Sam Rivera' };
  const DANA = { userId: 'u-dana', name: 'Dana Whitfield' };
  const PRIYA = { userId: 'u-priya', name: 'Priya Patel' };
  let n = 0;
  const message = (from: typeof SAM, at: number, mentions: (typeof SAM)[] = []): ChatMessage => {
    n += 1;
    return {
      id: `m${n}`,
      from,
      event: null,
      createdAt: at,
      modifiedAt: at,
      deleted: false,
      text: 'hi',
      mentions,
      reactions: [],
      attachments: [],
      replyTo: null,
    };
  };
  function chatItem(id: string, chatType: ChatDetail['chatType'], messages: ChatMessage[]): Item {
    return {
      ...todo(id),
      kind: 'chat',
      source: 'teams',
      account: TEAMS,
      externalId: `19:${id}`,
      title: chatType === 'one-on-one' ? 'Dana Whitfield' : 'Launch crew',
      detail: {
        kind: 'chat',
        chatType,
        topic: null,
        webUrl: null,
        members: [],
        lastReadAt: null,
        hidden: false,
        joinUrl: null,
        messages,
        ...chatFlags({ messages, lastReadAt: null }, SAM.userId),
      },
    };
  }
  const chats = { users, now: NOW };

  it('opens a Chat’s row at the message that put it there', () => {
    const first = message(DANA, NOW - 2 * HOUR);
    const last = message(DANA, NOW - HOUR);
    const dana = chatItem('dana', 'one-on-one', [first, last]);
    const [row] = feedRows([ranking('dana', 'today')], [dana], {}, new Map(), new Map(), chats);
    expect(row?.focus).toEqual({ messageId: last.id, at: last.createdAt, why: 'unanswered' });
  });

  it('opens a Chat Ares placed (no rule would) at its latest message', () => {
    const latest = message(PRIYA, NOW - HOUR);
    const launch = chatItem('launch', 'group', [message(DANA, NOW - 2 * HOUR), latest]);
    const [row] = feedRows([ranking('launch', 'waiting')], [launch], {}, new Map(), new Map(), chats);
    expect(row?.focus).toEqual({ messageId: latest.id, at: latest.createdAt, why: 'latest' });
  });

  it('keeps a cleared Chat off until a newer qualifying message, whatever its band', () => {
    const dana = chatItem('dana', 'one-on-one', [message(DANA, NOW - HOUR)]);
    const clears: Clears = { dana: { band: 'today', at: NOW - 30 * 60_000 } };
    expect(feedRows([ranking('dana', 'now')], [dana], clears, new Map(), new Map(), chats)).toEqual([]);
    expect(keepClears(clears, [ranking('dana', 'now')], NOW, [dana], users)).toBe(clears);

    // Dana writes again: the row is back, and the clear is forgotten.
    const again = chatItem('dana', 'one-on-one', [message(DANA, NOW - HOUR), message(DANA, NOW - 60_000)]);
    expect(feedRows([ranking('dana', 'today')], [again], clears, new Map(), new Map(), chats)).toHaveLength(
      1,
    );
    expect(keepClears(clears, [ranking('dana', 'today')], NOW, [again], users)).toEqual({});
  });

  it('stamps a Chat TMS with its type, and says on the right why and since when', () => {
    const dana = chatItem('dana', 'one-on-one', [message(DANA, NOW - 40 * 60_000)]);
    const launch = chatItem('launch', 'group', [message(PRIYA, NOW - 3 * HOUR, [SAM])]);
    expect(sourceTag(dana)).toEqual({ stamp: 'TMS', text: 'One-to-one chat' });
    expect(sourceTag(launch)).toEqual({ stamp: 'TMS', text: 'Group chat' });
    const [danaRow, launchRow] = feedRows(
      [ranking('dana', 'today', 1), ranking('launch', 'today', 2)],
      [dana, launch],
      {},
      new Map(),
      new Map(),
      chats,
    );
    expect(danaRow && rowMeta(danaRow, NOW)).toEqual(['40M', 'Unanswered']);
    expect(launchRow && rowMeta(launchRow, NOW)).toEqual(['3H', 'Mention']);
  });
});

const SHORT_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
