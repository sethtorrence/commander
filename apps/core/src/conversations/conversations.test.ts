import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONVERSATIONS_MESSAGES,
  type ConversationsRequest,
  type ConversationsResults,
  type ConversationTokens,
  type ConversationTurn,
  type ConversationView,
  defaultModelSettings,
  type ModelSettings,
  withTokens,
} from '@commander/domain';
import {
  createModelClient,
  ModelError,
  type ModelProviderAdapter,
  type ProviderReply,
  type ProviderRequest,
} from '@commander/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { createKnownSecrets } from '../safety/known-secrets';
import { CONVERSATION_JOB, type Conversations, servedOnThisMachine, setUpConversations } from '.';

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const DAY = '2026-10-06';

// A model call the test writes as it goes: tokens, then the end (or a failure). Stop aborts it as a
// real provider does.
type Call = {
  request: ProviderRequest;
  write(token: string): void;
  finish(usage?: { inputTokens: number; outputTokens: number }): void;
  fail(error: Error): void;
};

function fakeProvider() {
  const calls: Call[] = [];
  let refuse: ModelError | null = null;
  const provider: ModelProviderAdapter = {
    send: () => Promise.reject(new Error('Conversations stream')),
    stream(request, onToken) {
      if (refuse) return Promise.reject(refuse);
      return new Promise<ProviderReply>((resolve, reject) => {
        let text = '';
        request.signal?.addEventListener('abort', () =>
          reject(new ModelError('cancelled', 'The call was cancelled.')),
        );
        calls.push({
          request,
          write(token) {
            text += token;
            onToken(token);
          },
          finish(usage = { inputTokens: 100, outputTokens: 20 }) {
            resolve({ text, usage: { ...usage, cachedTokens: 0 } });
          },
          fail: reject,
        });
      });
    },
  };
  return {
    provider,
    calls,
    refuseWith(error: ModelError | null) {
      refuse = error;
    },
  };
}

let dir: string;
let store: ItemStore;
let model: ReturnType<typeof fakeProvider>;
let conversations: Conversations;
let sent: unknown[];
let nextId: number;

function setUp(options: { oneAtATime?: boolean; historyBudget?: number; secrets?: string[] } = {}) {
  model = fakeProvider();
  const client = createModelClient({
    settings: () => store.models.settings(),
    providers: { zai: model.provider },
    ledger: store.models,
  });
  const secrets = createKnownSecrets();
  for (const secret of options.secrets ?? []) secrets.remember(secret);
  conversations = setUpConversations({
    store: store.conversations,
    client,
    settings: () => store.models.settings(),
    secrets,
    send: (message) => sent.push(message),
    oneAtATime: options.oneAtATime === undefined ? undefined : () => options.oneAtATime as boolean,
    historyBudget: options.historyBudget,
    log: () => {},
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-conversations-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
  });
  sent = [];
  nextId = 1;
});

afterEach(() => {
  conversations?.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// A request from the window, as the main process relays it, and the Core's answer.
async function ask<R extends ConversationsRequest>(request: R): Promise<ConversationsResults[R['op']]> {
  const id = nextId++;
  expect(conversations.handle({ type: CONVERSATIONS_MESSAGES.request, id, request })).toBe(true);
  let reply: { response: { ok: boolean; result?: unknown; error?: string } } | undefined;
  await vi.waitFor(() => {
    reply = sent.find(
      (message) =>
        (message as { type?: string; id?: number }).type === CONVERSATIONS_MESSAGES.reply &&
        (message as { id: number }).id === id,
    ) as typeof reply;
    expect(reply).toBeDefined();
  });
  if (!reply?.response.ok) throw new Error(reply?.response.error);
  return reply.response.result as ConversationsResults[R['op']];
}

const pushedTurns = () =>
  sent
    .filter((message) => (message as { type?: string }).type === 'conversation-turn')
    .map((message) => (message as { turn: ConversationTurn }).turn);

// What the window would show of an answer from the tokens pushed so far.
const streamed = (turnId: number) =>
  sent
    .filter(
      (message): message is ConversationTokens =>
        (message as { type?: string }).type === 'conversation-tokens' &&
        (message as ConversationTokens).turnId === turnId,
    )
    .reduce((text, piece) => withTokens(text, piece), '');

const answerOf = (view: ConversationView) => view.turns.at(-1) as ConversationTurn;

async function settled(conversationId: string, status: ConversationTurn['status'] = 'done') {
  let view: ConversationView | null = null;
  await vi.waitFor(() => {
    view = store.conversations.view(conversationId);
    expect(view?.turns.at(-1)?.status).toBe(status);
  });
  return view as unknown as ConversationView;
}

function saveSettings(change: (settings: ModelSettings) => ModelSettings) {
  store.models.saveSettings(change(store.models.settings()));
}

describe('talking to Ares in a Conversation', () => {
  it('streams his answer to the window as he writes it, on the Deep tier, and keeps it', async () => {
    setUp();
    const today = await ask({ op: 'today', day: DAY });
    const view = await ask({ op: 'send', conversationId: today.conversation.id, text: 'How do tides work?' });
    expect(view.conversation.title).toBe('How do tides work?');
    expect(view.turns.map((turn) => [turn.by, turn.status])).toEqual([
      ['user', 'done'],
      ['ares', 'streaming'],
    ]);
    const turnId = answerOf(view).id;
    await vi.waitFor(() => expect(model.calls).toHaveLength(1));
    const call = model.calls[0] as Call;
    // Deep tier, its thinking: the instructions alone in the system message, then the User's words.
    expect(call.request.reasoningEffort).toBe(defaultModelSettings.tiers.deep.reasoningEffort);
    expect(call.request.messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(call.request.messages[0]?.content).toMatch(/You are Ares/);
    expect(call.request.messages[1]?.content).toBe('How do tides work?');

    call.write('[general]\n');
    call.write('The Moon’s pull');
    await vi.waitFor(() => expect(streamed(turnId)).toBe('The Moon’s pull'));
    call.write(' raises the sea.');
    call.finish();
    const done = await settled(today.conversation.id);
    expect(answerOf(done)).toMatchObject({ text: 'The Moon’s pull raises the sea.', ownKnowledge: true });
    expect(streamed(turnId)).toBe('The Moon’s pull raises the sea.');
    expect(pushedTurns().at(-1)).toMatchObject({ id: turnId, status: 'done' });

    // Logged under its own job, counted like every call.
    expect(store.models.usageSummary().byJob).toEqual([
      expect.objectContaining({ job: CONVERSATION_JOB, calls: 1 }),
    ]);
  });

  it('follows a per-job thinking override for Conversations', async () => {
    setUp();
    saveSettings((settings) => ({ ...settings, jobOverrides: { conversation: { reasoningEffort: 'max' } } }));
    const { conversation } = await ask({ op: 'today', day: DAY });
    await ask({ op: 'send', conversationId: conversation.id, text: 'Think hard: why is the sky blue?' });
    await vi.waitFor(() => expect(model.calls[0]?.request.reasoningEffort).toBe('max'));
  });

  it('says plainly he can’t do what none of his Skills can, without the own-knowledge mark', async () => {
    setUp();
    const { conversation } = await ask({ op: 'today', day: DAY });
    await ask({ op: 'send', conversationId: conversation.id, text: 'Email Dana that I’m running late' });
    await vi.waitFor(() => expect(model.calls).toHaveLength(1));
    model.calls[0]?.write('[cant]\nSending is yours to do.');
    model.calls[0]?.finish();
    const done = await settled(conversation.id);
    expect(answerOf(done)).toMatchObject({
      text: 'I can’t do that yet. Sending is yours to do.',
      ownKnowledge: false,
      links: [],
      updateId: null,
      skills: [],
    });
  });

  it('Stop ends an answer early and keeps what he wrote', async () => {
    setUp();
    const { conversation } = await ask({ op: 'today', day: DAY });
    await ask({ op: 'send', conversationId: conversation.id, text: 'Tell me a long story' });
    await vi.waitFor(() => expect(model.calls).toHaveLength(1));
    model.calls[0]?.write('[general]\nOnce upon a time');
    await vi.waitFor(() =>
      expect(streamed(answerOf(store.conversations.view(conversation.id) as ConversationView).id)).not.toBe(
        '',
      ),
    );
    const stopped = await ask({ op: 'stop', conversationId: conversation.id });
    expect(answerOf(stopped)).toMatchObject({
      status: 'stopped',
      text: 'Once upon a time',
      ownKnowledge: true,
    });
    expect(stopped.conversation.answering).toBe(false);
    // The User can go on.
    const next = await ask({ op: 'send', conversationId: conversation.id, text: 'Shorter, please' });
    expect(answerOf(next).status).toBe('streaming');
  });

  it('refuses the User’s next message while he is still answering', async () => {
    setUp();
    const { conversation } = await ask({ op: 'today', day: DAY });
    await ask({ op: 'send', conversationId: conversation.id, text: 'First' });
    await expect(ask({ op: 'send', conversationId: conversation.id, text: 'Second' })).rejects.toThrow(
      /still answering/,
    );
  });

  it('sends earlier turns back as history, within the budget, oldest dropped first', async () => {
    setUp({ historyBudget: 60 });
    const { conversation } = await ask({ op: 'today', day: DAY });
    const say = async (text: string, answer: string) => {
      const count = model.calls.length;
      await ask({ op: 'send', conversationId: conversation.id, text });
      await vi.waitFor(() => expect(model.calls).toHaveLength(count + 1));
      model.calls[count]?.write(`[chat]\n${answer}`);
      model.calls[count]?.finish();
      await settled(conversation.id);
    };
    await say('First question here', 'First answer');
    await say('Second question', 'Second answer');
    await ask({ op: 'send', conversationId: conversation.id, text: 'Third question' });
    await vi.waitFor(() => expect(model.calls).toHaveLength(3));
    const messages = model.calls[2]?.request.messages
      .slice(1)
      .map((message) => [message.role, message.content]);
    // 74 characters in all: the first question and its answer go.
    expect(messages).toEqual([
      ['user', 'Second question'],
      ['assistant', 'Second answer'],
      ['user', 'Third question'],
    ]);
  });

  it('answers two Conversations at once on a cloud model', async () => {
    setUp({ oneAtATime: false });
    const first = await ask({ op: 'today', day: DAY });
    const second = await ask({ op: 'new', day: DAY });
    await ask({ op: 'send', conversationId: first.conversation.id, text: 'Write me a long summary of WWII' });
    const quick = await ask({ op: 'send', conversationId: second.conversation.id, text: 'What is 2 + 2?' });
    expect(answerOf(quick).status).toBe('streaming');
    await vi.waitFor(() => expect(model.calls).toHaveLength(2));
    model.calls[1]?.write('[general]\n4.');
    model.calls[1]?.finish();
    expect(answerOf(await settled(second.conversation.id)).text).toBe('4.');
    // The long one is still being written.
    expect(answerOf(store.conversations.view(first.conversation.id) as ConversationView).status).toBe(
      'streaming',
    );
  });

  it('with a model on this machine, the second Conversation waits its turn and says so', async () => {
    setUp();
    saveSettings((settings) => ({
      ...settings,
      tiers: { ...settings.tiers, deep: { ...settings.tiers.deep, baseUrl: 'http://127.0.0.1:8080/v1' } },
    }));
    const first = await ask({ op: 'today', day: DAY });
    const second = await ask({ op: 'new', day: DAY });
    await ask({ op: 'send', conversationId: first.conversation.id, text: 'A long one' });
    const waiting = await ask({ op: 'send', conversationId: second.conversation.id, text: 'A quick one' });
    expect(answerOf(waiting).status).toBe('queued');
    expect(waiting.conversation.answering).toBe(true);
    expect(pushedTurns()).toContainEqual(
      expect.objectContaining({ id: answerOf(waiting).id, status: 'queued' }),
    );
    await vi.waitFor(() => expect(model.calls).toHaveLength(1));
    model.calls[0]?.write('[chat]\nDone.');
    model.calls[0]?.finish();
    await settled(first.conversation.id);
    // Now it's the second one's turn.
    await vi.waitFor(() => expect(model.calls).toHaveLength(2));
    expect(answerOf(store.conversations.view(second.conversation.id) as ConversationView).status).toBe(
      'streaming',
    );
  });

  it('takes a waiting answer out of the queue on Stop', async () => {
    setUp({ oneAtATime: true });
    const first = await ask({ op: 'today', day: DAY });
    const second = await ask({ op: 'new', day: DAY });
    await ask({ op: 'send', conversationId: first.conversation.id, text: 'A long one' });
    await ask({ op: 'send', conversationId: second.conversation.id, text: 'A quick one' });
    const stopped = await ask({ op: 'stop', conversationId: second.conversation.id });
    expect(answerOf(stopped)).toMatchObject({ status: 'stopped', text: '' });
    // And Send again asks him once more.
    const again = await ask({ op: 'retry', conversationId: second.conversation.id });
    expect(answerOf(again).status).toBe('queued');
  });

  it('keeps the User’s message to send again when there is no key, and answers on Send again', async () => {
    setUp();
    model.refuseWith(new ModelError('no-key', 'No Z.ai API key is saved.'));
    const { conversation } = await ask({ op: 'today', day: DAY });
    await ask({ op: 'send', conversationId: conversation.id, text: 'Hello?' });
    const failed = await settled(conversation.id, 'failed');
    expect(failed.turns.map((turn) => turn.by)).toEqual(['user', 'ares']);
    expect(failed.turns[0]?.text).toBe('Hello?');
    expect(answerOf(failed).problem).toMatch(/no model key saved.*Settings → Ares/);

    model.refuseWith(null);
    const again = await ask({ op: 'retry', conversationId: conversation.id });
    expect(again.turns.map((turn) => [turn.by, turn.status])).toEqual([
      ['user', 'done'],
      ['ares', 'streaming'],
    ]);
    await vi.waitFor(() => expect(model.calls).toHaveLength(1));
  });

  it('stops at the monthly cap, saying why, without calling the model', async () => {
    setUp();
    saveSettings((settings) => ({ ...settings, monthlyCapUsd: 1 }));
    store.models.record({
      at: Date.now(),
      job: 'suggest-todos',
      tier: 'quick',
      provider: 'zai',
      model: 'glm-5.3-flash',
      inputTokens: 1,
      cachedTokens: 0,
      outputTokens: 1,
      latencyMs: 1,
      costUsd: 5,
      outcome: 'ok',
    });
    const { conversation } = await ask({ op: 'today', day: DAY });
    await ask({ op: 'send', conversationId: conversation.id, text: 'Hello?' });
    const failed = await settled(conversation.id, 'failed');
    expect(answerOf(failed).problem).toMatch(/reached your cap/);
    expect(model.calls).toHaveLength(0);
  });

  it('says why a failed call failed, in his own words', async () => {
    setUp();
    const { conversation } = await ask({ op: 'today', day: DAY });
    await ask({ op: 'send', conversationId: conversation.id, text: 'Hello?' });
    await vi.waitFor(() => expect(model.calls).toHaveLength(1));
    model.calls[0]?.write('[chat]\nHel');
    model.calls[0]?.fail(
      new ModelError('unavailable', 'The model provider is having trouble (HTTP 503). It said: <html>'),
    );
    const failed = await settled(conversation.id, 'failed');
    expect(answerOf(failed).problem).toBe(
      'I couldn’t get an answer from the model just now. Send this again in a moment.',
    );
    expect(answerOf(failed).text).toBe('Hel');
  });

  it('never sends a message holding one of the User’s keys', async () => {
    const key = 'lin_api_9f8e7d6c5b4a39281706';
    setUp({ secrets: [key] });
    const { conversation } = await ask({ op: 'today', day: DAY });
    await ask({ op: 'send', conversationId: conversation.id, text: `Is this key valid? ${key}` });
    const failed = await settled(conversation.id, 'failed');
    expect(answerOf(failed).problem).toMatch(/sign-in tokens or keys/);
    expect(model.calls).toHaveLength(0);
  });

  it('deletes a Conversation and its turns, stopping his answer, and Undo puts it back', async () => {
    setUp();
    const { conversation } = await ask({ op: 'today', day: DAY });
    await ask({ op: 'send', conversationId: conversation.id, text: 'Keep me' });
    await vi.waitFor(() => expect(model.calls).toHaveLength(1));
    model.calls[0]?.write('[chat]\nKept');
    await vi.waitFor(() =>
      expect(streamed(answerOf(store.conversations.view(conversation.id) as ConversationView).id)).toBe(
        'Kept',
      ),
    );
    expect(await ask({ op: 'delete', conversationId: conversation.id })).toEqual({
      conversationId: conversation.id,
    });
    expect(await ask({ op: 'list' })).toEqual([]);
    await expect(ask({ op: 'open', conversationId: conversation.id })).rejects.toThrow(/no longer/);

    const back = await ask({ op: 'undo-delete', conversationId: conversation.id });
    expect(back.turns.map((turn) => [turn.by, turn.text, turn.status])).toEqual([
      ['user', 'Keep me', 'done'],
      ['ares', 'Kept', 'stopped'],
    ]);
    await expect(ask({ op: 'undo-delete', conversationId: conversation.id })).rejects.toThrow(
      /can’t be put back/,
    );
  });

  it('never starts or writes into a Conversation unprompted', async () => {
    setUp();
    const { conversation } = await ask({ op: 'today', day: DAY });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(model.calls).toHaveLength(0);
    expect(pushedTurns()).toEqual([]);
    expect(store.conversations.view(conversation.id)?.turns).toEqual([]);
    // Nothing the window can send writes one of his turns.
    expect(
      conversations.handle({
        type: CONVERSATIONS_MESSAGES.request,
        id: 99,
        request: { op: 'answer', conversationId: conversation.id },
      }),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({ id: 99, response: expect.objectContaining({ ok: false }) }),
      ),
    );
    expect(store.conversations.view(conversation.id)?.turns).toEqual([]);
    expect(conversations.handle({ type: 'updates-request', id: 1 })).toBe(false);
  });

  it('stops answers left unfinished when Commander closed, keeping what he wrote', async () => {
    setUp();
    const { conversation } = await ask({ op: 'today', day: DAY });
    await ask({ op: 'send', conversationId: conversation.id, text: 'Go on' });
    await vi.waitFor(() => expect(model.calls).toHaveLength(1));
    model.calls[0]?.write('[general]\nHalfway');
    await vi.waitFor(() =>
      expect(streamed(answerOf(store.conversations.view(conversation.id) as ConversationView).id)).toBe(
        'Halfway',
      ),
    );
    conversations.stop();
    expect(answerOf(store.conversations.view(conversation.id) as ConversationView)).toMatchObject({
      status: 'stopped',
      text: 'Halfway',
    });
  });
});

describe('which models answer one thing at a time', () => {
  it('is a model served on this machine', () => {
    expect(servedOnThisMachine('http://127.0.0.1:8080/v1')).toBe(true);
    expect(servedOnThisMachine('http://localhost:11434/v1')).toBe(true);
    expect(servedOnThisMachine('http://[::1]:8080/v1')).toBe(true);
    expect(servedOnThisMachine('https://api.z.ai/api/paas/v4')).toBe(false);
    expect(servedOnThisMachine('not a url')).toBe(false);
  });
});
