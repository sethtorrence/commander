import type { ActivityEntry, ChatDetail, OutgoingChange, Project } from '@commander/domain';
import type { AccountSummary } from '@commander/domain/ipc';
import { describe, expect, it } from 'vitest';
import { checkLine, describeChatEntry } from './teams-chats';
import { chat, NOW, TEAMS } from './test-chats';

// How the Teams Section words a Chat's activity log and its thin status line.

const TL: Project = {
  id: 'p-tl',
  name: 'Titanlink',
  code: 'TL',
  accent: 'teal',
  order: 0,
  archived: false,
  createdAt: 0,
};

let id = 0;
const entry = (overrides: Partial<ActivityEntry>): ActivityEntry => {
  id += 1;
  return {
    id,
    at: NOW,
    by: { kind: 'user' },
    action: 'update',
    itemId: 'chat-1',
    otherItemId: null,
    otherProjectId: null,
    why: null,
    causedBy: null,
    undoes: null,
    changes: [],
    ...overrides,
  };
};

const teams = { kind: 'source', source: 'teams', account: TEAMS } as const;
const messages = (added: number, changed = 0) => [
  { field: 'messages', count: 10, added, changed, removed: 0, latest: null },
];

describe('a Chat’s activity, in words', () => {
  it('says what Teams did, from the summaries the log keeps', () => {
    expect(describeChatEntry(entry({ action: 'create', by: teams, summaries: messages(4) }), [])).toBe(
      'Added from Teams',
    );
    expect(describeChatEntry(entry({ by: teams, summaries: messages(1) }), [])).toBe(
      '1 new message in Teams',
    );
    expect(describeChatEntry(entry({ by: teams, summaries: messages(3) }), [])).toBe(
      '3 new messages in Teams',
    );
    expect(describeChatEntry(entry({ by: teams, summaries: messages(0, 2) }), [])).toBe(
      'Messages changed in Teams',
    );
    expect(describeChatEntry(entry({ action: 'tombstone', by: teams }), [])).toBe('Left or deleted in Teams');
  });

  it('says who filed it and under what, and what an undo reversed', () => {
    const filed = entry({
      changes: [{ field: 'filing', before: null, after: { projectId: TL.id, filedBy: 'user' } }],
    });
    const undone = entry({ action: 'undo', undoes: filed.id });

    expect(describeChatEntry(filed, [undone, filed], [TL])).toBe('Filed under TL by you');
    expect(describeChatEntry(undone, [undone, filed], [TL])).toBe('Filing undone by you');
  });

  it('says when the User excluded it, and when Ares saw instructions aimed at him', () => {
    expect(describeChatEntry(entry({ action: 'delete', why: 'Excluded the Chat from Commander' }), [])).toBe(
      'Excluded from Commander by you',
    );
    expect(
      describeChatEntry(
        entry({
          action: 'injection-warning',
          by: { kind: 'ares' },
          why: 'This chat contains instructions aimed at Ares. He ignored them.',
        }),
        [],
      ),
    ).toBe('This chat contains instructions aimed at Ares. He ignored them.');
  });
});

describe('replies and read state, in words', () => {
  const detail = chat({ id: '19:priya', title: 'Priya Patel' }).detail as ChatDetail;
  const unread = { ...detail, unreadCount: 2 };
  const read = { ...detail, unreadCount: 0 };
  const reply = { clientId: 'c1', text: 'On it.', createdAt: NOW };
  const replied = entry({
    changes: [{ field: 'detail', before: read, after: { ...read, replies: [reply] } }],
  });
  const outgoing = (status: OutgoingChange['status']): OutgoingChange => ({
    id: 1,
    itemId: 'chat-1',
    source: 'teams',
    account: TEAMS,
    field: 'message:c1',
    status,
    madeAt: NOW,
    attempts: 0,
    error: null,
  });

  it('says a reply was sent to Teams once it is there, and where it stands until then', () => {
    expect(describeChatEntry(replied, [replied])).toBe('Replied by you · sent to Teams');
    expect(describeChatEntry(replied, [replied], [], [outgoing('pending')])).toBe(
      'Replied by you · sending to Teams',
    );
    expect(describeChatEntry(replied, [replied], [], [outgoing('failed')])).toBe(
      'Replied by you · couldn’t sync',
    );
  });

  it('says a cancelled reply was cancelled, and never sent', () => {
    const cancelled = entry({ action: 'undo', undoes: replied.id });
    expect(describeChatEntry(replied, [cancelled, replied])).toBe('Replied by you · cancelled');
    expect(describeChatEntry(cancelled, [cancelled, replied])).toBe('Reply cancelled by you');
  });

  it('says when the User read the Chat or marked it unread, and what undo reversed', () => {
    const readIt = entry({ changes: [{ field: 'detail', before: unread, after: read }] });
    const markedUnread = entry({ changes: [{ field: 'detail', before: read, after: unread }] });
    const undone = entry({ action: 'undo', undoes: readIt.id });
    expect(describeChatEntry(readIt, [readIt])).toBe('Marked read by you');
    expect(describeChatEntry(markedUnread, [markedUnread])).toBe('Marked unread by you');
    expect(describeChatEntry(undone, [undone, readIt])).toBe('Mark as read undone by you');
  });

  it('says when the Chat was read, or marked unread, in Teams', () => {
    const summaries = [{ field: 'messages', count: 1, added: 0, changed: 0, removed: 0, latest: null }];
    const readThere = entry({
      by: teams,
      summaries,
      changes: [{ field: 'detail', before: unread, after: { ...read, lastReadAt: NOW } }],
    });
    const unreadThere = entry({
      by: teams,
      summaries,
      changes: [{ field: 'detail', before: read, after: { ...unread, lastReadAt: NOW - 1 } }],
    });
    expect(describeChatEntry(readThere, [readThere])).toBe('Read in Teams');
    expect(describeChatEntry(unreadThere, [unreadThere])).toBe('Marked unread in Teams');
  });

  it('gives Teams’s note when a newer change there won over the User’s', () => {
    const note = entry({
      by: teams,
      why: 'Changed in Teams at 14:02',
      summaries: [{ field: 'messages', count: 1, added: 0, changed: 0, removed: 0, latest: null }],
    });
    expect(describeChatEntry(note, [note])).toBe('Changed in Teams at 14:02');
  });
});

const account = (
  sync: Partial<NonNullable<AccountSummary['sync']>> | null,
  name = 'Teams · sam@contoso.test',
) =>
  ({
    id: TEAMS,
    source: 'teams',
    name,
    userPrincipalName: 'sam@contoso.test',
    method: 'oauth',
    status: 'connected',
    user: { id: 'u-sam', name: 'Sam Rivera' },
    sync: sync && {
      account: TEAMS,
      source: 'teams',
      activity: 'idle',
      cadenceMinutes: 1440,
      cadenceChoices: [1440],
      lastSyncedAt: null,
      nextSyncAt: null,
      itemCount: 0,
      problem: null,
      outgoing: { pending: 0, failed: 0 },
      alsoAfterOtherSources: true,
      ...sync,
    },
  }) as AccountSummary;

describe('the status line', () => {
  const now = new Date(NOW);

  it('says when Teams was last checked, that it is checking, or its problem', () => {
    expect(checkLine([], now)).toEqual({ text: 'No Teams Account connected', problem: false });
    expect(checkLine([account({ lastSyncedAt: new Date(2026, 9, 3, 11, 2).getTime() })], now)).toEqual({
      text: 'Checked 11:02',
      problem: false,
    });
    expect(checkLine([account({ activity: 'syncing' })], now).text).toBe('Checking…');
    expect(
      checkLine(
        [account({ problem: { kind: 'rate-limited', message: 'Teams asked Commander to slow down' } })],
        now,
      ),
    ).toEqual({ text: 'Teams asked Commander to slow down', problem: true });
  });

  it('names each Account when there are several', () => {
    expect(
      checkLine(
        [
          account({ lastSyncedAt: new Date(2026, 9, 3, 11, 2).getTime() }, 'Teams · sam@contoso.test'),
          account({ activity: 'syncing' }, 'Teams · sam@fabrikam.test'),
        ],
        now,
      ).text,
    ).toBe('Teams · sam@contoso.test checked 11:02 · Teams · sam@fabrikam.test checking…');
  });
});
