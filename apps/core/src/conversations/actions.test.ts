import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONVERSATIONS_MESSAGES,
  type ConversationsRequest,
  type ConversationsResults,
  type ConversationTurn,
  type ConversationView,
  createSkillRegistry,
  type Item,
} from '@commander/domain';
import { createModelClient, type ModelProviderAdapter, type ProviderRequest } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowCloudMail, deliver } from '../agent/fixtures/emails';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { createFileSkill } from '../skills/file';
import { createFindSkill } from '../skills/find';
import { createLinearActionsSkill } from '../skills/linear-actions';
import { createManageTodosSkill } from '../skills/manage-todos';
import { createSnoozeSkill } from '../skills/snooze';
import { type Conversations, setUpConversations } from '.';
import { createAboutReader } from './about';

// Ares acting from a Conversation (#196), with a real Item store, gate and Skill registry and a model
// that answers each call from what it was asked: an action Skill's proposals go through the gate with
// the Conversation as their cause, are kept on his answer for its cards, and what came of them is
// Commander's note in his next call. Something read from outside leads only to chained suggestions.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const TODAY = '2026-10-06';
// Just after midnight, on the machine's own clock.
const NOW = new Date(2026, 9, 6, 0, 10).getTime();

type Reply = (request: ProviderRequest, index: number) => string;

let dir: string;
let store: ItemStore;
let gate: Gate;
let conversations: Conversations;
let sent: unknown[];
let nextId: number;
let requests: ProviderRequest[];
let reply: Reply;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  dir = mkdtempSync(join(tmpdir(), 'commander-conversation-actions-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
  });
  gate = openGate({ itemStore: store });
  sent = [];
  nextId = 1;
  requests = [];
  const skills = createSkillRegistry();
  const options = { itemStore: store, gate, now: () => NOW };
  skills.register(createFindSkill({ itemStore: store, now: () => NOW }));
  skills.register(createManageTodosSkill(options));
  skills.register(createFileSkill(options));
  skills.register(createSnoozeSkill(options));
  skills.register(createLinearActionsSkill(options));
  const provider: ModelProviderAdapter = {
    send: () => Promise.reject(new Error('Conversations stream')),
    async stream(request, onToken) {
      const index = requests.push(request) - 1;
      const text = reply(request, index);
      for (const token of text.match(/[\s\S]{1,7}/g) ?? []) onToken(token);
      return { text, usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 20 } };
    },
  };
  const client = createModelClient({
    settings: () => store.models.settings(),
    providers: { zai: provider },
    ledger: store.models,
  });
  conversations = setUpConversations({
    store: store.conversations,
    client,
    settings: () => store.models.settings(),
    send: (message) => sent.push(message),
    oneAtATime: () => false,
    skills,
    item: (itemId) => store.get(itemId)?.item ?? null,
    readAbout: createAboutReader({ itemStore: store }),
    injectionWarnings: store.injectionWarnings,
    log: () => {},
  });
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
  let answer: { response: { ok: boolean; result?: unknown; error?: string } } | undefined;
  await vi.waitFor(() => {
    answer = sent.find(
      (message) =>
        (message as { type?: string }).type === CONVERSATIONS_MESSAGES.reply &&
        (message as { id: number }).id === id,
    ) as typeof answer;
    expect(answer).toBeDefined();
  });
  if (!answer?.response.ok) throw new Error(answer?.response.error);
  return answer.response.result as ConversationsResults[R['op']];
}

async function say(
  text: string,
  about?: string,
): Promise<{ answer: ConversationTurn; conversationId: string }> {
  const { conversation } = about
    ? await ask({ op: 'new', day: TODAY, about })
    : await ask({ op: 'today', day: TODAY });
  await ask({ op: 'send', conversationId: conversation.id, text });
  let view: ConversationView | null = null;
  await vi.waitFor(() => {
    view = store.conversations.view(conversation.id);
    expect(view?.turns.at(-1)?.status).toMatch(/done|failed/);
  });
  const answer = (view as unknown as ConversationView).turns.at(-1) as ConversationTurn;
  return { answer, conversationId: conversation.id };
}

const system = (request: ProviderRequest) => request.messages[0]?.content ?? '';
const last = (request: ProviderRequest) => (request.messages.at(-1) as { content: string }).content;
const refOf = (request: ProviderRequest, label: string) =>
  new RegExp(`ref="(I\\d+)" label="I\\d+ · ${label}`).exec(last(request))?.[1];

describe('Ares acting from a Conversation', () => {
  it('adds the Todo the User asked for through the gate, keeps it on his answer, and tells him what came of it', async () => {
    let told = '';
    reply = (request, index) => {
      if (index === 0)
        return '[skill]\n{"skill":"todos","input":{"action":"add","title":"Send Leo the redlines","due":"friday"}}';
      told = last(request);
      return '[their-data]\nAdded: send Leo the redlines, due Friday.';
    };

    const { answer, conversationId } = await say('Add a Todo to send Leo the redlines by Friday');

    // He was told he can act, through the Skills that act, and how.
    expect(system(requests[0] as ProviderRequest)).toContain(
      'The Skills that act (Manage Todos, File, Snooze, Linear actions) only ever hand Commander what the User asked for',
    );
    const todo = store.query({ kinds: ['todo'] })[0] as Item;
    expect(todo).toMatchObject({ title: 'Send Leo the redlines', detail: { dueOn: '2026-10-09' } });
    expect(answer).toMatchObject({ status: 'done', skills: ['todos'], proposalIds: [expect.any(Number)] });
    expect(store.autonomy.proposal(answer.proposalIds[0] as number)).toMatchObject({
      status: 'done',
      conversation: { conversationId, turnId: answer.id },
      reason: 'You asked in a Conversation: “Add a Todo to send Leo the redlines by Friday”',
    });
    // What came of it is Commander's own note, in his next call.
    expect(told).toContain('Manage Todos: Done: add the Todo you asked for, due Friday 9 October.');
  });

  it('chains a change that follows from outside material it read: always a card, with the email as its cause', async () => {
    gate.setLevel({ scope: 'everywhere', actionKind: 'organise' }, 'auto');
    allowCloudMail(store);
    const ids = deliver(store, NOW, [{ id: 'paid', subject: 'Invoice paid', text: 'The invoice is paid.' }]);
    const invoice = store.record(
      {
        type: 'create',
        item: {
          kind: 'todo',
          title: 'Pay the invoice',
          detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null },
        },
      },
      { by: { kind: 'user' } },
    ).itemId;
    reply = (request, index) => {
      if (index === 0) return '[skill]\n{"skill":"find","input":{"query":"invoice"}}';
      if (index === 1) {
        return `[skill]\n{"skill":"todos","input":{"action":"done","todos":["${refOf(request, 'Todo')}"]}}`;
      }
      return '[their-data]\nIt waits for you to confirm.';
    };

    const { answer } = await say('Mark the invoice Todo done');

    expect(store.get(invoice)?.item.status).toBe('open');
    const [card] = gate.activity({ ids: answer.proposalIds });
    expect(card).toMatchObject({
      status: 'pending',
      chained: true,
      itemId: invoice,
      cause: { item: { id: ids.paid } },
    });
    gate.accept(card?.id as number);
    expect(store.get(invoice)?.item.status).toBe('done');
  });

  it('refuses a ref he wasn’t handed for this answer before anything is proposed, and tells him why', async () => {
    reply = (_request, index) =>
      index === 0
        ? '[skill]\n{"skill":"linear","input":{"action":"state","issues":["I3"],"state":"In Review"}}'
        : '[their-data]\nI couldn’t find that issue.';

    const { answer } = await say('Move LT-142 to In Review');

    expect(answer.proposalIds).toEqual([]);
    expect(store.autonomy.proposals()).toEqual([]);
    expect(last(requests[1] as ProviderRequest)).toContain(
      'Your last Skill request couldn’t be used: I3 isn’t one of the Items you were given for this message.',
    );
  });

  it('acts on the Item a pop-up Conversation is about as the settings say, and chains what reaches beyond it', async () => {
    allowCloudMail(store);
    const longtail = store.changeProject({
      type: 'create',
      project: { name: 'Longtail', code: 'LT', accent: 'blue' },
    }).project?.id;
    const ids = deliver(store, NOW, [{ id: 'leo', subject: 'Redlines from Leo' }]);
    const email = ids.leo as string;
    reply = (_request, index) => {
      if (index === 0) return '[skill]\n{"skill":"file","input":{"items":["I1"],"project":"LT"}}';
      if (index === 1)
        return '[skill]\n{"skill":"todos","input":{"action":"add","title":"Send Leo the redlines"}}';
      return '[their-data]\nFiled, and a Todo waits for you.';
    };

    const { answer } = await say('File this under Longtail and add a Todo for it', email);

    const [filed, todo] = gate.activity({ ids: answer.proposalIds }).sort((a, b) => a.id - b.id);
    // Filing the email it is about acts on that outside Item alone: done, as Organise allows.
    expect(filed).toMatchObject({ status: 'done', chained: false, itemId: email });
    expect(store.get(email)?.item.filing).toEqual({ projectId: longtail, filedBy: 'ares' });
    // A Todo made from nothing reaches beyond it: chained, waiting, with the email as its cause.
    expect(todo).toMatchObject({ status: 'pending', chained: true, cause: { item: { id: email } } });
    expect(store.query({ kinds: ['todo'] })).toEqual([]);
  });
});
