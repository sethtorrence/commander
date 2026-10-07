import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONVERSATION_SCHEDULE,
  CONVERSATIONS_MESSAGES,
  type ConversationsRequest,
  type ConversationsResults,
  type ConversationTurn,
  type ConversationView,
  createSkillRegistry,
  type DraftEmailRequest,
} from '@commander/domain';
import { createModelClient, type ModelProviderAdapter, type ProviderRequest } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowCloudMail, deliver } from '../agent/fixtures/emails';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { createDraftSkill } from '../skills/draft';
import { createFindSkill } from '../skills/find';
import { createScheduleSkill } from '../skills/schedule';
import { type Conversations, setUpConversations } from '.';
import { createAboutReader } from './about';

// Draft and Schedule from a Conversation (#198), with a real Item store, gate and Skill registry and a
// model that answers each call from what it was asked (the drafting call and Find time stand in): a
// draft is kept on his answer to show under it, with nothing proposed and nothing sent, and an event
// he prepares waits for the User as a card, with the Conversation as its cause.

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
let drafts: DraftEmailRequest[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  dir = mkdtempSync(join(tmpdir(), 'commander-conversation-making-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
  });
  gate = openGate({ itemStore: store });
  sent = [];
  nextId = 1;
  requests = [];
  drafts = [];
  const skills = createSkillRegistry();
  skills.register(createFindSkill({ itemStore: store, now: () => NOW }));
  skills.register(
    createDraftSkill({
      itemStore: store,
      draftEmail: async (request) => {
        drafts.push(request);
        return {
          state: 'ready',
          answering: request.itemId,
          body: 'Hi Dana,\n\nThursday works.\n\nAlex',
          addedLinks: [],
          confidence: 0.9,
          sure: true,
          at: NOW,
        };
      },
      draftChat: () => Promise.reject(new Error('no Chats here')),
    }),
  );
  skills.register(
    createScheduleSkill({
      itemStore: store,
      gate,
      now: () => NOW,
      findTime: async (request) => ({
        slots: [{ start: request.from + 9 * 3_600_000, end: request.from + 10 * 3_600_000 }],
        timeZone: 'UTC',
        guests: [],
        bookingLink: null,
      }),
    }),
  );
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

const CALENDAR = 'google:104512345678901234567';

describe('Draft and Schedule in a Conversation', () => {
  it('drafts a reply to the email a pop-up is about, with the User’s words, shown under the answer and never sent', async () => {
    allowCloudMail(store);
    const ids = deliver(store, NOW, [{ id: 'dana', subject: 'Q4 offsite dates', text: 'Which dates work?' }]);
    const email = ids.dana as string;
    let told = '';
    reply = (request, index) => {
      if (index === 0) return '[skill]\n{"skill":"draft","input":{"item":"I1"}}';
      told = last(request);
      return '[their-data]\nHere’s a draft for you to send [I1].';
    };

    const { answer } = await say('Reply to this saying Thursday works', email);

    // Draft, Meeting prep and Schedule are offered, and he is told he never sends.
    expect(system(requests[0] as ProviderRequest)).toContain('- draft (Draft):');
    expect(system(requests[0] as ProviderRequest)).toContain('- schedule (Schedule):');
    expect(system(requests[0] as ProviderRequest)).toContain('You never send or save a message');
    expect(drafts).toEqual([{ itemId: email, instruction: 'Reply to this saying Thursday works' }]);
    expect(answer).toMatchObject({
      status: 'done',
      skills: ['draft'],
      proposalIds: [],
      made: [
        {
          kind: 'email-draft',
          itemId: email,
          title: 'Q4 offsite dates',
          body: 'Hi Dana,\n\nThursday works.\n\nAlex',
        },
      ],
    });
    expect(told).toContain('Draft: a draft of the User’s reply to I1 is ready');
    expect(told).toContain('It hasn’t been sent');
    // Nothing went to the gate, and nothing was written to send.
    expect(store.autonomy.proposals()).toEqual([]);
    expect(
      store.query({ kinds: ['email'] }).filter((item) => item.detail?.kind === 'email' && item.detail.draft),
    ).toEqual([]);
  });

  it('prepares the event the User asked for as a card waiting for them, with the Conversation as its cause', async () => {
    store.calendars.listed(CALENDAR, 'google-calendar', [
      {
        id: 'alex@gmail.test',
        name: 'alex@gmail.test',
        colour: '#9fe1e7',
        primary: true,
        accessRole: 'owner',
      },
    ]);
    reply = (_request, index) =>
      index === 0
        ? '[skill]\n{"skill":"schedule","input":{"action":"meeting","with":["leo@acme.test"],"minutes":60,"when":"next-week"}}'
        : '[their-data]\nIt waits for you to confirm.';

    const { answer, conversationId } = await say('Find an hour with leo@acme.test next week');

    expect(answer.proposalIds).toHaveLength(1);
    const [card] = gate.activity({ ids: answer.proposalIds });
    expect(card).toMatchObject({
      action: CONVERSATION_SCHEDULE,
      status: 'pending',
      chained: false,
      conversation: { conversationId, turnId: answer.id },
    });
    expect(card?.itemActions[0]).toMatchObject({
      type: 'create-event',
      event: { kind: 'meeting', attendees: [{ email: 'leo@acme.test' }] },
    });
    // Nothing is in the calendar until the User confirms.
    expect(store.query({ kinds: ['event'] })).toEqual([]);
  });
});
