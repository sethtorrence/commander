import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActionContext,
  type ChatMember,
  type ChatMessage,
  FILE_INTO_PROJECTS,
  type Project,
  type SourceItem,
} from '@commander/domain';
import { createModelClient, type ModelProviderAdapter, type ProviderRequest } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { fileIntoProjectsJob } from './file-into-projects';
import { createJobRunner, type JobRunner } from './runner';

// "File into Projects" on Teams Chats (#108), end to end through the runner: Chats saved as Teams
// sync saves them, in a real Item store, with the gate deciding. The model is a fake provider
// answering with recorded-style replies (GLM-5.3-Flash in JSON mode), keyed by the Chat's name.

const user: ActionContext = { by: { kind: 'user' } };
const TEAMS = 'teams:tenant-1:u-sam';
const SAM: ChatMember = { userId: 'u-sam', name: 'Sam Rivera', email: 'sam@contoso.test' };
const OMAR: ChatMember = { userId: 'u-omar', name: 'Omar Haddad', email: 'omar@titanlink.io' };
const PRIYA: ChatMember = { userId: 'u-priya', name: 'Priya Patel', email: 'priya@contoso.test' };
const LEE: ChatMember = { userId: 'u-lee', name: 'Lee Chen', email: 'lee@contoso.test' };
const T = Date.UTC(2026, 9, 3, 9);

let dir: string;
let clock: number;
let store: ItemStore;
let gate: Gate;
let runner: JobRunner;
let calls: ProviderRequest[];
// What the fake model answers for each Chat, by its name.
let replies: Record<string, { projectCode: string; confidence: number; reason?: string }>;
let lt: Project;
let tl: Project;
let tx: Project;

const provider: ModelProviderAdapter = {
  async send(request) {
    calls.push(request);
    const content = request.messages.at(-1)?.content ?? '';
    const [, ref] = /label="(I\d+) · Teams Chat"/.exec(content) ?? [];
    const [, name] = /┆ Chat name: (.*)/.exec(content) ?? [];
    const reply = name ? replies[name] : undefined;
    const filings = reply && ref ? [{ itemId: ref, ...reply }] : [];
    return {
      text: JSON.stringify({ filings, steering: [] }),
      usage: { inputTokens: 700, cachedTokens: 0, outputTokens: 40 },
    };
  },
  stream: () => Promise.reject(new Error('not used')),
};

function project(name: string, code: string): Project {
  return store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project as Project;
}

const said = (from: ChatMember, text: string, n: number): ChatMessage => ({
  id: `m-${n}-${text.length}`,
  from: { userId: from.userId, name: from.name },
  event: null,
  createdAt: T + n * 60_000,
  modifiedAt: T + n * 60_000,
  deleted: false,
  text,
  mentions: [],
  reactions: [],
  attachments: [],
  replyTo: null,
});

type ChatInput = {
  id: string;
  title: string;
  members?: ChatMember[];
  chatType?: 'one-on-one' | 'group' | 'meeting';
  messages?: ChatMessage[];
};

function chat({
  id,
  title,
  members = [SAM, PRIYA],
  chatType = 'group',
  messages = [],
}: ChatInput): SourceItem {
  return {
    externalId: id,
    kind: 'chat',
    title,
    people: members.flatMap((member) => [`teams:${member.userId}`, member.email as string]),
    detail: {
      kind: 'chat',
      chatType,
      topic: chatType === 'one-on-one' ? null : title,
      webUrl: null,
      members,
      lastReadAt: null,
      hidden: false,
      joinUrl: null,
      messages,
      unreadCount: 0,
      mentionsMe: false,
      latestFromMe: false,
      lastMessageAt: messages.at(-1)?.createdAt ?? null,
    },
  };
}

// Saves Chats as Teams sync does, and returns their Item ids by name.
function sync(...chats: ChatInput[]): Record<string, string> {
  clock += 1000;
  store.saveFromSource({ source: 'teams', account: TEAMS, items: chats.map(chat) });
  return Object.fromEntries(store.query({ kinds: ['chat'] }).map((item) => [item.title, item.id]));
}

const fileByHand = (itemId: string, into: Project) =>
  store.record(
    { type: 'update', itemId, changes: { filing: { projectId: into.id, filedBy: 'user' } } },
    user,
  );

const filingOf = (id: string) => store.get(id)?.item.filing ?? null;
const prompts = () => calls.map((call) => call.messages.at(-1)?.content ?? '');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-file-chats-'));
  clock = T;
  calls = [];
  replies = {};
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  lt = project('Longtail', 'LT');
  tl = project('Titanlink', 'TL');
  tx = project('Tactics', 'TX');
  // "Chat is Launch crew → LT".
  store.changeRule({
    type: 'create',
    rule: {
      target: { kind: 'project', projectId: lt.id },
      when: {
        join: 'and',
        terms: [{ field: 'teams.chat', op: 'is', value: '19:launch', label: 'Launch crew' }],
      },
    },
  });
  gate = openGate({ itemStore: store });
  runner = createJobRunner({
    jobs: [fileIntoProjectsJob(store)],
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
});

afterEach(() => {
  runner.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function run(itemIds: string[] = []) {
  runner.trigger({ kind: 'items-arrived', itemIds });
  await runner.settled();
}

describe('File into Projects, on Teams Chats', () => {
  it('skips Rule-matched and hand-filed Chats, and sends each other Chat in a data block of its own', async () => {
    const ids = sync(
      { id: '19:launch', title: 'Launch crew' },
      { id: '19:social', title: 'Social' },
      { id: '19:relay', title: 'Relay rollout', members: [SAM, OMAR, PRIYA] },
    );
    fileByHand(ids.Social as string, tx);
    expect(filingOf(ids['Launch crew'] as string)).toEqual({ projectId: lt.id, filedBy: 'rule' });

    await run();

    // One call, for the one Chat no Rule filed and the User didn't file.
    expect(prompts()).toHaveLength(1);
    const prompt = prompts()[0] as string;
    expect(prompt).toMatch(/<data-\w+ ref="U1" label="I1 · Teams Chat" source="outside">/);
    expect(prompt).toContain('┆ Chat name: Relay rollout');
    expect(prompt).not.toContain('Chat name: Launch crew');
    expect(prompt).not.toContain('Chat name: Social');
    // The Projects and Rules are the User's own material.
    expect(prompt).toMatch(/label="Projects" source="the User">/);
    expect(prompt).toContain('Rule: Chat is Launch crew');
  });

  it('describes the Chat: its name and type, its people and their Projects, its latest messages and linked Items', async () => {
    // Omar is in two Chats the User filed under TL, and one Ares filed (which doesn't count).
    const earlier = sync(
      { id: '19:omar', title: 'Omar Haddad', members: [SAM, OMAR], chatType: 'one-on-one' },
      { id: '19:tl-eng', title: 'TL eng', members: [SAM, OMAR, LEE] },
      { id: '19:tl-ops', title: 'TL ops', members: [SAM, OMAR] },
    );
    fileByHand(earlier['Omar Haddad'] as string, tl);
    fileByHand(earlier['TL eng'] as string, tl);
    store.record(
      {
        type: 'update',
        itemId: earlier['TL ops'] as string,
        changes: { filing: { projectId: tx.id, filedBy: 'ares' } },
      },
      { by: { kind: 'ares' } },
    );
    const messages = Array.from({ length: 14 }, (_, n) =>
      said(n % 2 ? OMAR : SAM, `Message ${n + 1} about the relay ${'very '.repeat(n === 13 ? 80 : 0)}`, n),
    );
    const ids = sync({ id: '19:relay', title: 'Relay rollout', members: [SAM, OMAR, PRIYA], messages });
    const todo = store.record(
      { type: 'create', item: { kind: 'todo', title: 'Reply about the relay' } },
      user,
    );
    fileByHand(todo.itemId, tl);
    store.link({ from: todo.itemId, linkType: 'about', to: ids['Relay rollout'] as string }, user);
    calls = [];

    await run([ids['Relay rollout'] as string]);

    const prompt = prompts().find((each) => each.includes('Chat name: Relay rollout')) as string;
    expect(prompt).toContain('┆ Chat type: group chat');
    expect(prompt).toContain(
      '┆ People: Omar Haddad (omar@titanlink.io), Priya Patel (priya@contoso.test), and the User',
    );
    expect(prompt).toContain('┆ Where its people’s other Chats are filed: Omar Haddad: TL (2)');
    expect(prompt).not.toContain('Priya Patel: ');
    // The last ten messages, oldest first, each trimmed, the User's own named as the User.
    expect(prompt).toContain('┆ Latest messages (oldest first):');
    expect(prompt).not.toContain('Message 4 about');
    expect(prompt).toContain('┆ the User: Message 5 about the relay');
    expect(prompt).toContain('┆ Omar Haddad: Message 14 about the relay very');
    expect(prompt).not.toMatch(/(very ){60}/);
    expect(prompt).toContain('┆ Linked Items’ Projects: TL (a todo)');
  });

  it('files a confident Chat as Ares, leaves a suggestion on a less confident one, and follows the Teams Autonomy setting', async () => {
    replies = {
      'Relay rollout': { projectCode: 'TL', confidence: 0.93, reason: 'Omar works on Titanlink' },
      'Pager talk': { projectCode: 'TX', confidence: 0.6 },
    };
    const ids = sync(
      { id: '19:relay', title: 'Relay rollout', members: [SAM, OMAR] },
      { id: '19:pager', title: 'Pager talk', members: [SAM, LEE] },
    );

    await run();

    const sure = ids['Relay rollout'] as string;
    expect(filingOf(sure)).toEqual({ projectId: tl.id, filedBy: 'ares' });
    expect(store.activity({ itemId: sure }).find((entry) => entry.by.kind === 'ares')).toMatchObject({
      action: 'update',
      why: 'Omar works on Titanlink',
    });
    const unsure = ids['Pager talk'] as string;
    expect(filingOf(unsure)).toBeNull();
    const [pending] = gate.activity({ itemId: unsure, statuses: ['pending'] });
    expect(pending).toMatchObject({ action: FILE_INTO_PROJECTS, decision: 'ask', section: 'teams' });
    expect(store.get(unsure)?.item.filingSuggestion).toEqual({ proposalId: pending?.id, projectId: tx.id });

    // With Organise at Ask in Teams, even a sure filing waits for the User.
    gate.setLevel({ scope: 'section', section: 'teams', actionKind: 'organise' }, 'ask');
    replies['Omar sync'] = { projectCode: 'TL', confidence: 0.97 };
    const more = sync({ id: '19:omar-sync', title: 'Omar sync', members: [SAM, OMAR] });
    await run([more['Omar sync'] as string]);
    expect(filingOf(more['Omar sync'] as string)).toBeNull();
    expect(gate.activity({ itemId: more['Omar sync'], statuses: ['pending'] })).toHaveLength(1);

    // Off in Teams: Chats aren't even sent.
    gate.setLevel({ scope: 'section', section: 'teams', actionKind: 'organise' }, 'off');
    calls = [];
    sync({ id: '19:new', title: 'Brand new', members: [SAM, LEE] });
    await run();
    expect(calls).toHaveLength(0);
  });

  it('considers each Chat once: new messages don’t send a Chat he filed again, nor one he left Unfiled until there is more to go on', async () => {
    replies = { 'Relay rollout': { projectCode: 'TL', confidence: 0.95 } };
    const first = [said(OMAR, 'Relay is slow', 1), said(SAM, 'Looking', 2), said(OMAR, 'Thanks', 3)];
    const ids = sync(
      { id: '19:relay', title: 'Relay rollout', members: [SAM, OMAR], messages: first },
      { id: '19:lunch', title: 'Lunch', members: [SAM, LEE], messages: first },
    );
    await run();
    expect(calls).toHaveLength(2);
    expect(filingOf(ids['Relay rollout'] as string)?.filedBy).toBe('ares');
    expect(filingOf(ids.Lunch as string)).toBeNull();

    // A new message in each: neither is sent again.
    calls = [];
    const second = [...first, said(LEE, 'Anyone?', 4)];
    sync(
      { id: '19:relay', title: 'Relay rollout', members: [SAM, OMAR], messages: second },
      { id: '19:lunch', title: 'Lunch', members: [SAM, LEE], messages: second },
    );
    await run(Object.values(ids));
    expect(calls).toHaveLength(0);

    // Once the Unfiled one has a full window of messages (ten), he looks again; the filed one, never.
    const full = [...second, ...Array.from({ length: 6 }, (_, n) => said(LEE, `More ${n}`, 5 + n))];
    sync(
      { id: '19:relay', title: 'Relay rollout', members: [SAM, OMAR], messages: full },
      { id: '19:lunch', title: 'Lunch', members: [SAM, LEE], messages: full },
    );
    await run(Object.values(ids));
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]).toContain('Chat name: Lunch');

    // A new person joining is something new to go on, too.
    calls = [];
    sync({ id: '19:lunch', title: 'Lunch', members: [SAM, LEE, PRIYA], messages: full });
    await run([ids.Lunch as string]);
    expect(prompts()).toHaveLength(1);
  });

  it('files muted Chats too, but never an excluded one', async () => {
    const ids = sync({ id: '19:muted', title: 'Muted chat' }, { id: '19:gone', title: 'Excluded chat' });
    store.chatSettings.change({ account: TEAMS, chatId: '19:muted', change: 'mute' }, user);
    store.chatSettings.change({ account: TEAMS, chatId: '19:gone', change: 'exclude' }, user);
    expect(store.get(ids['Excluded chat'] as string)?.item.deletedAt).not.toBeNull();

    await run();

    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]).toContain('Chat name: Muted chat');
  });

  it('a Rule matching later replaces Ares’s filing of a Chat', async () => {
    replies = { 'Relay rollout': { projectCode: 'TL', confidence: 0.95 } };
    const ids = sync({ id: '19:relay', title: 'Relay rollout', members: [SAM, OMAR] });
    await run();
    expect(filingOf(ids['Relay rollout'] as string)?.filedBy).toBe('ares');

    store.changeRule({
      type: 'create',
      rule: {
        target: { kind: 'project', projectId: tx.id },
        when: {
          join: 'and',
          terms: [{ field: 'teams.person', op: 'is', value: 'omar@titanlink.io', label: 'Omar Haddad' }],
        },
      },
    });
    sync({ id: '19:relay', title: 'Relay rollout', members: [SAM, OMAR], messages: [said(OMAR, 'hi', 1)] });
    expect(filingOf(ids['Relay rollout'] as string)).toEqual({ projectId: tx.id, filedBy: 'rule' });
  });
});
