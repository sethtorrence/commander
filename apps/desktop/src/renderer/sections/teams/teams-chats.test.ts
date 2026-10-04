import type { ActivityEntry, Project } from '@commander/domain';
import type { AccountSummary } from '@commander/domain/ipc';
import { describe, expect, it } from 'vitest';
import { checkLine, describeChatEntry } from './teams-chats';
import { NOW, TEAMS } from './test-chats';

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
