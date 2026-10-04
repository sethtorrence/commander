import { describe, expect, it } from 'vitest';
import { compactForLog, summarisedInLog, withoutUntouched } from './logged-fields';
import type { ChatDetail, ChatMessage } from './teams';

const T = Date.UTC(2026, 9, 3, 9);

const message = (id: string, at: number, text = `Message ${id}`): ChatMessage => ({
  id,
  from: { userId: 'u-priya', name: 'Priya Patel' },
  event: null,
  createdAt: at,
  modifiedAt: at,
  deleted: false,
  text,
  mentions: [],
  reactions: [],
  attachments: [],
  replyTo: null,
});

const chat = (messages: ChatMessage[], unreadCount = 0): ChatDetail => ({
  kind: 'chat',
  chatType: 'group',
  topic: 'Launch crew',
  webUrl: null,
  members: [],
  lastReadAt: null,
  hidden: false,
  joinUrl: null,
  messages,
  unreadCount,
  mentionsMe: false,
  latestFromMe: false,
  lastMessageAt: messages.at(-1)?.createdAt ?? null,
});

describe('detail fields the activity log keeps only in summary', () => {
  it('names a Chat’s messages', () => {
    expect(summarisedInLog('chat')).toEqual(['messages']);
    expect(summarisedInLog('linear-issue')).toEqual([]);
  });

  it('logs a change to them as how many were added, changed and removed, and the newest, and keeps the rest', () => {
    const before = chat([message('1', T), message('2', T + 1), message('3', T + 2)]);
    const after = chat(
      [message('2', T + 1), message('3', T + 2, 'Edited'), message('4', T + 3), message('5', T + 4)],
      2,
    );

    const logged = compactForLog(before, after);

    expect(logged.summaries).toEqual([
      { field: 'messages', count: 4, added: 2, changed: 1, removed: 1, latest: { id: '5', at: T + 4 } },
    ]);
    expect(logged.before).toEqual({ ...before, messages: [] });
    expect(logged.after).toEqual({ ...after, messages: [] });
  });

  it('summarises them in a creation too, and leaves details without such fields alone', () => {
    const created = compactForLog(null, chat([message('1', T)]));
    expect(created.summaries).toEqual([
      { field: 'messages', count: 1, added: 1, changed: 0, removed: 0, latest: { id: '1', at: T } },
    ]);

    const todo = { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null } as const;
    expect(compactForLog(todo, todo)).toEqual({ before: todo, after: todo, summaries: [] });
  });
});

describe('changes made in Commander', () => {
  it('leave out the summarised fields they didn’t touch (reading a Chat or replying never changes its messages)', () => {
    const before = chat([message('1', T), message('2', T + 1)], 2);
    const after = { ...before, unreadCount: 0, lastReadAt: T + 1 };

    expect(withoutUntouched(before, after)).toEqual({
      before: { ...before, messages: [] },
      after: { ...after, messages: [] },
    });
  });

  it('are logged whole when they did touch them, and details without such fields stay as they are', () => {
    const before = chat([message('1', T)]);
    const after = chat([message('1', T, 'Edited')]);
    expect(withoutUntouched(before, after)).toEqual({ before, after });
    expect(withoutUntouched(null, after)).toEqual({ before: null, after });
    const todo = { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null } as const;
    expect(withoutUntouched(todo, todo)).toEqual({ before: todo, after: todo });
  });
});
