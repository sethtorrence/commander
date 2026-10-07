import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONVERSATIONS_MESSAGES,
  type ConversationsRequest,
  type ConversationsResults,
  type ConversationTurn,
  type ConversationView,
  type Memory,
} from '@commander/domain';
import {
  createModelClient,
  ModelError,
  type ModelProviderAdapter,
  type ProviderRequest,
} from '@commander/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowCloudMail, deliver } from '../agent/fixtures/emails';
import { factKey } from '../agent/learn-facts';
import { recall } from '../agent/memory-context';
import { type ItemStore, openItemStore } from '../item-store';
import { type Conversations, setUpConversations } from '.';
import { createAboutReader } from './about';
import { asksToForget, createRememberer, REMEMBER_JOB, ungrounded } from './remember';

// What the User tells Ares in a Conversation becomes confirmed Memory (#194): learned by a call of
// its own that reads only the User's words, kept with their turn as its source, said in a line under
// his answer with Undo, corrected or forgotten when they say so, and recalled in later Conversations.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const TODAY = '2026-10-06';
const NOW = new Date(2026, 9, 6, 9, 0).getTime();

// What the fake model answers: a Conversation's answer (streamed), and what to remember (a JSON reply).
type Answer = (request: ProviderRequest) => string;
type Learn = (request: ProviderRequest) => unknown;

let dir: string;
let store: ItemStore;
let conversations: Conversations;
let sent: unknown[];
let nextId: number;
let answers: ProviderRequest[];
let learns: ProviderRequest[];
let answer: Answer;
let learn: Learn;
let logged: string[];

function setUp() {
  const provider: ModelProviderAdapter = {
    async send(request) {
      learns.push(request);
      const text = JSON.stringify(learn(request));
      return { text, usage: { inputTokens: 50, cachedTokens: 0, outputTokens: 10 } };
    },
    async stream(request, onToken) {
      answers.push(request);
      const text = answer(request);
      for (const token of text.match(/[\s\S]{1,7}/g) ?? []) onToken(token);
      return { text, usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 20 } };
    },
  };
  const client = createModelClient({
    settings: () => store.models.settings(),
    providers: { zai: provider },
    ledger: store.models,
  });
  const item = (itemId: string) => store.get(itemId)?.item ?? null;
  conversations = setUpConversations({
    store: store.conversations,
    client,
    settings: () => store.models.settings(),
    send: (message) => sent.push(message),
    oneAtATime: () => false,
    item,
    readAbout: createAboutReader({ itemStore: store }),
    remember: createRememberer({
      client,
      memory: store.memory,
      projects: () => store.projects(),
      people: () => store.people.list(),
      item,
      log: (line) => logged.push(line),
    }),
    recall: (text) => recall(store, { text, confirmedOnly: true }),
    log: (line) => logged.push(line),
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  dir = mkdtempSync(join(tmpdir(), 'commander-remember-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
  });
  sent = [];
  nextId = 1;
  answers = [];
  learns = [];
  logged = [];
  answer = () => '[chat]\nNoted.';
  learn = () => ({ remember: [], forget: [] });
});

afterEach(() => {
  conversations?.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

async function ask<R extends ConversationsRequest>(request: R): Promise<ConversationsResults[R['op']]> {
  const id = nextId++;
  expect(conversations.handle({ type: CONVERSATIONS_MESSAGES.request, id, request })).toBe(true);
  let reply: { response: { ok: boolean; result?: unknown; error?: string } } | undefined;
  await vi.waitFor(() => {
    reply = sent.find(
      (message) =>
        (message as { type?: string }).type === CONVERSATIONS_MESSAGES.reply &&
        (message as { id: number }).id === id,
    ) as typeof reply;
    expect(reply).toBeDefined();
  });
  if (!reply?.response.ok) throw new Error(reply?.response.error);
  return reply.response.result as ConversationsResults[R['op']];
}

// The User says something; once the learn call is answered (and `lines` lines are under it) and Ares
// has finished, his answer.
async function say(
  conversationId: string,
  text: string,
  { status = 'done', lines = 0 }: { status?: ConversationTurn['status']; lines?: number } = {},
): Promise<ConversationTurn> {
  const calls = learns.length;
  await ask({ op: 'send', conversationId, text });
  let turn: ConversationTurn | undefined;
  await vi.waitFor(() => {
    turn = store.conversations.view(conversationId)?.turns.at(-1);
    expect(turn?.status).toBe(status);
    expect(learns.length).toBe(calls + 1);
    expect(turn?.remembered).toHaveLength(lines);
  });
  return turn as ConversationTurn;
}

const lastLearn = () =>
  learns
    .at(-1)
    ?.messages.map((message) => message.content)
    .join('\n') ?? '';
const memories = (): Memory[] => store.memory.list().memories;
const userTurnOf = (view: ConversationView | null, answerTurn: ConversationTurn) =>
  view?.turns.find((turn) => turn.id === answerTurn.replyTo) as ConversationTurn;

const PREFERENCE = {
  kind: 'preference',
  text: 'The User doesn’t take meetings before 10',
  said: 'you don’t take meetings before 10',
};
const LEO = {
  kind: 'fact',
  text: 'Leo is the User’s contact at Acme',
  said: 'Leo is your contact at Acme',
  person: 'Leo',
};

describe('what can be kept', () => {
  it('rests on the User’s words: every name and number in it is one they wrote', () => {
    expect(ungrounded(PREFERENCE.text, 'I don’t take meetings before 10')).toEqual([]);
    expect(ungrounded(LEO.text, 'Leo is our Acme contact')).toEqual([]);
    // Another form of one of their words is theirs too.
    expect(ungrounded('Prefers short emails', 'I prefer short emails')).toEqual([]);
    expect(ungrounded('Dana is the User’s contact at Initech', 'Leo is our Acme contact')).toEqual([
      'Dana',
      'Initech',
    ]);
    expect(ungrounded('The User doesn’t take meetings before 11', 'no meetings before 10am')).toEqual(['11']);
    expect(ungrounded('No meetings before 10', 'no meetings before 10am')).toEqual([]);
  });

  it('forgets only when the User asks', () => {
    expect(asksToForget('Forget that')).toBe(true);
    expect(asksToForget('That’s wrong, Leo left')).toBe(true);
    expect(asksToForget('Leo isn’t our contact any more')).toBe(true);
    expect(asksToForget('What’s on today?')).toBe(false);
  });
});

describe('what the User tells Ares in a Conversation', () => {
  it('becomes a confirmed memory written by the User, from their turn, said under his answer with a working Undo', async () => {
    setUp();
    learn = () => ({ remember: [PREFERENCE], forget: [] });
    const { conversation } = await ask({ op: 'today', day: TODAY });
    const said = await say(conversation.id, 'I don’t take meetings before 10', { lines: 1 });

    expect(said.remembered).toEqual([
      {
        memoryId: expect.any(String),
        did: 'learned',
        line: 'I’ll remember that you don’t take meetings before 10.',
        undone: false,
      },
    ]);
    const view = store.conversations.view(conversation.id);
    const [kept] = memories();
    expect(kept).toMatchObject({
      id: said.remembered[0]?.memoryId,
      kind: 'preference',
      text: 'The User doesn’t take meetings before 10',
      confirmed: true,
      by: 'user',
      sources: [],
      turns: [
        {
          conversationId: conversation.id,
          turnId: userTurnOf(view, said).id,
          conversation: { title: 'I don’t take meetings before 10', day: TODAY, daily: true },
        },
      ],
      forReview: false,
    });
    // The window heard of it as his turn changed.
    expect(
      sent.some(
        (message) =>
          (message as { type?: string }).type === 'conversation-turn' &&
          (message as { turn: ConversationTurn }).turn.remembered.length === 1,
      ),
    ).toBe(true);

    // A call of its own on the Quick tier, its own line on the Usage page, reading the User's words.
    expect(learns[0]?.reasoningEffort).toBe('low');
    expect(lastLearn()).toMatch(/^You are Ares\. The User is talking with you in a Conversation/);
    expect(lastLearn()).toMatch(
      /label="The User’s latest message" source="the User">\nI don’t take meetings before 10/,
    );
    expect(store.models.usageSummary().byJob.map((each) => each.job)).toContain(REMEMBER_JOB);

    // Undo on the line: the memory goes, and the line says it was undone.
    const undone = await ask({
      op: 'undo-remembered',
      conversationId: conversation.id,
      turnId: said.id,
      memoryId: kept?.id as string,
    });
    expect(undone.remembered).toEqual([expect.objectContaining({ undone: true })]);
    expect(memories()).toEqual([]);
    expect(store.memory.get(kept?.id as string)).toBeNull();
    // Gone altogether, not kept as deleted: saying it again keeps it again.
    expect(store.memory.knows([factKey(PREFERENCE.text, 'preference')]).size).toBe(0);
  });

  it('keeps nothing from an Item in the Conversation: the call never reads it, and what the User didn’t write is dropped', async () => {
    allowCloudMail(store);
    const ids = deliver(store, NOW, [
      { id: 'offsite', subject: 'Q4 offsite', text: 'Dana here: the offsite is on 12 November in Lisbon.' },
    ]);
    setUp();
    // Fooled by the email, the model offers its facts as the User's.
    learn = () => ({
      remember: [
        {
          kind: 'fact',
          text: 'The offsite is on 12 November in Lisbon',
          said: 'the offsite is on 12 November in Lisbon',
        },
      ],
      forget: [],
    });
    const started = await ask({ op: 'new', day: TODAY, about: ids.offsite });
    const said = await say(started.conversation.id, 'Remember what this says');

    // Ares read the email to answer; the call that keeps memories never did.
    expect(answers[0]?.messages.at(-1)?.content).toContain('the offsite is on 12 November in Lisbon');
    expect(lastLearn()).not.toContain('Lisbon');
    expect(lastLearn()).not.toMatch(/<data-\w+ [^>]*source="outside"/);
    expect(said.remembered).toEqual([]);
    expect(memories()).toEqual([]);
    expect(logged.join('\n')).toMatch(/named 12, November, Lisbon, which the User didn’t write/);
  });

  it('keeps no words of a memory picked up from outside unless the User wrote them', async () => {
    allowCloudMail(store);
    const ids = deliver(store, NOW, [{ id: 'leo', subject: 'Intro', text: 'Leo now works at Acme.' }]);
    const outside = store.memory.learn({
      kind: 'fact',
      key: factKey('Leo works at Acme'),
      text: 'Leo works at Acme',
      confirmed: false,
      sources: [ids.leo as string],
    }) as Memory;
    setUp();
    learn = () => ({ remember: [{ kind: 'fact', text: 'Leo works at Acme', replaces: 'M1' }], forget: [] });
    const { conversation } = await ask({ op: 'today', day: TODAY });
    const said = await say(conversation.id, 'Yes, Leo does');

    // Handed in only as background, and its words don't become confirmed.
    expect(lastLearn()).toMatch(
      /label="What Ares has picked up \(unconfirmed\)" source="background">\n┆ \[M1\]/,
    );
    expect(said.remembered).toEqual([]);
    expect(store.memory.get(outside.id)).toMatchObject({ text: 'Leo works at Acme', confirmed: false });
  });

  it('changes a memory the User corrects, saying what changed, and Undo puts it back', async () => {
    setUp();
    const { conversation } = await ask({ op: 'today', day: TODAY });
    learn = () => ({ remember: [LEO], forget: [] });
    const first = await say(conversation.id, 'Leo is our Acme contact', { lines: 1 });
    const leo = first.remembered[0]?.memoryId as string;
    expect(store.memory.get(leo)).toMatchObject({ kind: 'fact', text: LEO.text, confirmed: true });

    learn = () => ({
      remember: [
        {
          kind: 'fact',
          text: 'Leo is the User’s contact at Globex',
          said: 'Leo is your contact at Globex',
          replaces: 'M1',
        },
      ],
      forget: [],
    });
    const second = await say(conversation.id, 'Actually Leo moved to Globex', { lines: 1 });
    // What this Conversation learned comes first, and the earlier message is there for context.
    expect(lastLearn()).toMatch(
      /label="What Ares knows" source="the User">\n\[M1\] \(fact\) Leo is the User’s contact at Acme/,
    );
    expect(lastLearn()).toMatch(
      /earlier messages in this Conversation" source="the User">\n- Leo is our Acme contact/,
    );
    expect(second.remembered).toEqual([
      {
        memoryId: leo,
        did: 'changed',
        line: 'I had “Leo is the User’s contact at Acme”. Now I’ll remember that Leo is your contact at Globex.',
        undone: false,
      },
    ]);
    expect(store.memory.get(leo)).toMatchObject({ text: 'Leo is the User’s contact at Globex' });
    expect(store.memory.get(leo)?.turns).toHaveLength(2);
    // His answer goes back with the lines saying what he remembered.
    const history = answers.at(-1)?.messages.map((message) => message.content) ?? [];
    expect(history).toContain('Noted.\n\nI’ll remember that Leo is your contact at Acme.');

    await ask({ op: 'undo-remembered', conversationId: conversation.id, turnId: second.id, memoryId: leo });
    expect(store.memory.get(leo)).toMatchObject({ text: LEO.text });
    expect(store.memory.get(leo)?.turns).toHaveLength(1);
  });

  it('forgets a memory the User asks him to, with Undo, and never when they didn’t ask', async () => {
    setUp();
    const { conversation } = await ask({ op: 'today', day: TODAY });
    learn = () => ({ remember: [PREFERENCE], forget: [] });
    const first = await say(conversation.id, 'I don’t take meetings before 10', { lines: 1 });
    const kept = first.remembered[0]?.memoryId as string;

    // Not asked: nothing goes.
    learn = () => ({ remember: [], forget: ['M1'] });
    const asked = await say(conversation.id, 'What’s on today?');
    expect(asked.remembered).toEqual([]);
    expect(store.memory.get(kept)).not.toBeNull();

    const forgot = await say(conversation.id, 'Forget that', { lines: 1 });
    expect(forgot.remembered).toEqual([
      {
        memoryId: kept,
        did: 'forgot',
        line: 'I’ve forgotten “The User doesn’t take meetings before 10”.',
        undone: false,
      },
    ]);
    expect(store.memory.get(kept)).toBeNull();

    await ask({ op: 'undo-remembered', conversationId: conversation.id, turnId: forgot.id, memoryId: kept });
    expect(store.memory.get(kept)).toMatchObject({ text: PREFERENCE.text, confirmed: true });
  });

  it('Send again keeps what he remembered, without asking again', async () => {
    setUp();
    learn = () => ({ remember: [PREFERENCE], forget: [] });
    answer = () => {
      throw new ModelError('unavailable', 'Down for a moment.');
    };
    const { conversation } = await ask({ op: 'today', day: TODAY });
    const failed = await say(conversation.id, 'I don’t take meetings before 10', {
      status: 'failed',
      lines: 1,
    });
    expect(failed.remembered).toHaveLength(1);

    answer = () => '[chat]\nNoted.';
    await ask({ op: 'retry', conversationId: conversation.id });
    await vi.waitFor(() =>
      expect(store.conversations.view(conversation.id)?.turns.at(-1)?.status).toBe('done'),
    );
    const again = store.conversations.view(conversation.id)?.turns.at(-1) as ConversationTurn;
    expect(again.id).not.toBe(failed.id);
    expect(again.remembered).toEqual(failed.remembered);
    expect(learns).toHaveLength(1);
    expect(memories()).toHaveLength(1);
  });

  it('is recalled in a later Conversation as the User’s own', async () => {
    setUp();
    learn = () => ({ remember: [PREFERENCE], forget: [] });
    const { conversation } = await ask({ op: 'today', day: TODAY });
    await say(conversation.id, 'I don’t take meetings before 10', { lines: 1 });

    learn = () => ({ remember: [], forget: [] });
    answer = () => '[their-data]\nNot before 10: you don’t take meetings then.';
    const later = await ask({ op: 'new', day: TODAY });
    await say(later.conversation.id, 'When can we hold the meetings tomorrow?');
    const prompt = answers.at(-1)?.messages.at(-1)?.content ?? '';
    expect(prompt).toMatch(
      /label="What Ares knows" source="the User">\n- \(preference\) The User doesn’t take meetings before 10/,
    );
  });

  it('stays when its Conversation is deleted, from “a deleted Conversation”', async () => {
    setUp();
    learn = () => ({ remember: [LEO], forget: [] });
    const { conversation } = await ask({ op: 'today', day: TODAY });
    const said = await say(conversation.id, 'Leo is our Acme contact', { lines: 1 });
    await ask({ op: 'delete', conversationId: conversation.id });

    const kept = store.memory.get(said.remembered[0]?.memoryId as string);
    expect(kept).toMatchObject({ text: LEO.text, confirmed: true, forReview: false });
    expect(kept?.turns).toEqual([
      expect.objectContaining({ conversationId: conversation.id, conversation: null }),
    ]);
  });
});
