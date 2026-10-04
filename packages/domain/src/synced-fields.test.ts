import { describe, expect, it } from 'vitest';
import type { LinearIssueDetail } from './linear';
import {
  isSyncedField,
  isUnrecallableField,
  statusFromDetail,
  syncedFieldsOf,
  withSyncedFields,
} from './synced-fields';
import type { ChatDetail, ChatMessage, ChatReply } from './teams';

const priya = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: null };
const bug = { id: 'label-bug', name: 'Bug', color: '#eb5757' };
const customer = { id: 'label-customer', name: 'Customer', color: '#5e6ad2' };
const comment = (id: string, createdAt: number) => ({
  id,
  author: priya,
  body: `Comment ${id}`,
  createdAt,
  updatedAt: createdAt,
});

const detail: LinearIssueDetail = {
  kind: 'linear-issue',
  identifier: 'ENG-418',
  url: 'https://linear.app/acme/issue/ENG-418',
  team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
  state: { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' },
  priority: 2,
  assignee: priya,
  creator: null,
  labels: [bug],
  cycle: null,
  linearProject: { id: 'lp-login', name: 'Login revamp' },
  dueDate: '2026-10-09',
  estimate: 3,
  description: 'Read-only',
  comments: [comment('c1', 10)],
  createdAt: 1,
  updatedAt: 2,
  startedAt: null,
  completedAt: null,
  canceledAt: null,
};

describe('a Linear issue’s synced fields', () => {
  it('keys every field that writes back on its own, each label and comment included', () => {
    expect(syncedFieldsOf(detail)).toEqual({
      state: detail.state,
      assignee: priya,
      priority: 2,
      dueDate: '2026-10-09',
      estimate: 3,
      cycle: null,
      linearProject: detail.linearProject,
      'label:label-bug': bug,
      'comment:c1': detail.comments[0],
    });
  });

  it('puts fields back in place, keeping labels by name and comments oldest first', () => {
    const fields = {
      ...syncedFieldsOf(detail),
      priority: 1,
      'label:label-customer': customer,
      'label:label-bug': null,
      'comment:c0': comment('c0', 5),
    };
    expect(withSyncedFields(detail, fields)).toEqual({
      ...detail,
      priority: 1,
      labels: [customer],
      comments: [comment('c0', 5), comment('c1', 10)],
    });
  });

  it('never touches what isn’t synced: the description, title and team', () => {
    const changed = withSyncedFields(detail, { ...syncedFieldsOf(detail), description: 'Hacked' });
    expect(changed.description).toBe('Read-only');
  });

  it('names which fields are synced', () => {
    expect(
      ['priority', 'label:x', 'comment:y', 'description', 'label:'].map((f) =>
        isSyncedField('linear-issue', f),
      ),
    ).toEqual([true, true, true, false, false]);
    expect(isSyncedField('todo', 'priority')).toBe(false);
  });

  it('has no synced fields for Commander’s own kinds', () => {
    expect(syncedFieldsOf({ kind: 'todo', origin: 'manual', dueOn: null, backedBy: null })).toBeNull();
    expect(syncedFieldsOf(null)).toBeNull();
  });

  it('closes the Item when the state is completed or canceled', () => {
    const done = { ...detail, state: { ...detail.state, type: 'completed' } };
    expect(statusFromDetail(done, 'open')).toBe('done');
    expect(statusFromDetail(detail, 'done')).toBe('open');
    expect(statusFromDetail(null, 'archived')).toBe('archived');
  });
});

const T = Date.UTC(2026, 9, 3, 9);
const MIN = 60_000;
const ME = 'u-sam';
const said = (id: string, at: number, from: string): ChatMessage => ({
  id,
  from: { userId: from, name: from },
  event: null,
  createdAt: at,
  modifiedAt: at,
  deleted: false,
  text: `Message ${id}`,
  mentions: [],
  reactions: [],
  attachments: [],
  replyTo: null,
});
const reply = (clientId: string, createdAt: number): ChatReply => ({
  clientId,
  text: `Reply ${clientId}`,
  createdAt,
});

// Priya wrote twice since the User last read the Chat, the second time mentioning them.
const chat: ChatDetail = {
  kind: 'chat',
  chatType: 'one-on-one',
  topic: null,
  webUrl: null,
  members: [],
  lastReadAt: T,
  hidden: false,
  joinUrl: null,
  messages: [said('1', T - MIN, ME), said('2', T + MIN, 'u-priya'), said('3', T + 2 * MIN, 'u-priya')],
  unreadCount: 2,
  mentionsMe: true,
  latestFromMe: false,
  lastMessageAt: T + 2 * MIN,
};
const read: ChatDetail = { ...chat, lastReadAt: T + 2 * MIN, unreadCount: 0, mentionsMe: false };

describe('a Chat’s synced fields', () => {
  it('keys whether it is read, and each reply not yet in Teams', () => {
    expect(syncedFieldsOf(chat)).toEqual({ read: false });
    const replying = { ...read, replies: [reply('c1', T + 3 * MIN)] };
    expect(syncedFieldsOf(replying)).toEqual({ read: true, 'message:c1': replying.replies[0] });
  });

  it('keeps replies oldest first, and none at all once the last one has gone', () => {
    const fields = {
      read: true,
      'message:c2': reply('c2', T + 4 * MIN),
      'message:c1': reply('c1', T + 3 * MIN),
    };
    expect(withSyncedFields(read, fields).replies).toEqual([
      reply('c1', T + 3 * MIN),
      reply('c2', T + 4 * MIN),
    ]);
    const replying = { ...read, replies: [reply('c1', T + 3 * MIN)] };
    expect(withSyncedFields(replying, { read: true, 'message:c1': null })).toEqual(read);
    expect(withSyncedFields(read, { read: true })).toEqual(read);
  });

  it('reads the Chat up to its latest message', () => {
    expect(withSyncedFields(chat, { read: true })).toEqual({
      ...chat,
      lastReadAt: T + 2 * MIN,
      unreadCount: 0,
      mentionsMe: false,
    });
  });

  it('marks it unread from its latest message from someone else', () => {
    expect(withSyncedFields(read, { read: false })).toEqual({
      ...read,
      lastReadAt: T + 2 * MIN - 1,
      unreadCount: 1,
    });
    // The User spoke last: Priya's message before it is the one left unread.
    const spokeLast: ChatDetail = {
      ...read,
      messages: [...read.messages, said('4', T + 5 * MIN, ME)],
      lastReadAt: T + 5 * MIN,
      latestFromMe: true,
      lastMessageAt: T + 5 * MIN,
    };
    expect(withSyncedFields(spokeLast, { read: false })).toMatchObject({
      lastReadAt: T + 2 * MIN - 1,
      unreadCount: 1,
    });
    // Nothing from anyone else: nothing to leave unread.
    const alone: ChatDetail = { ...spokeLast, messages: [said('4', T + 5 * MIN, ME)] };
    expect(withSyncedFields(alone, { read: false })).toEqual(alone);
  });

  it('names which fields are synced, and which can’t be taken back once sent', () => {
    expect(
      ['read', 'message:c1', 'message:', 'topic', 'messages'].map((f) => isSyncedField('chat', f)),
    ).toEqual([true, true, false, false, false]);
    expect(isUnrecallableField('chat', 'message:c1')).toBe(true);
    expect(isUnrecallableField('chat', 'read')).toBe(false);
    expect(isUnrecallableField('linear-issue', 'comment:c1')).toBe(false);
  });

  it('never changes the Item’s status', () => {
    expect(statusFromDetail(chat, 'open')).toBe('open');
  });
});
