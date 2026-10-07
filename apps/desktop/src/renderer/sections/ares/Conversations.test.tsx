// @vitest-environment jsdom

import { writeBlock } from '@commander/core/src/agent/testing/meeting-fixtures';
import {
  type Conversations as CoreConversations,
  setUpConversations,
  UNFINISHED_PROBLEM,
} from '@commander/core/src/conversations';
import { createRememberer } from '@commander/core/src/conversations/remember';
import type { ItemStore } from '@commander/core/src/item-store';
import { createFindSkill } from '@commander/core/src/skills/find';
import {
  CONVERSATIONS_MESSAGES,
  type CoreMessage,
  createSkillRegistry,
  DRAFT_SKILL,
  FIND_SKILL,
  type QueuedLine,
  type SkillRegistry,
  UPDATE_SKILL,
  type UpdatesRequest,
  type UpdateView,
} from '@commander/domain';
import {
  createModelClient,
  ModelError,
  type ModelProviderAdapter,
  type ProviderReply,
} from '@commander/models';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requestReveal } from '../../frame/reveal';
import { openTestItemStore } from '../../item-store/test-item-store';
import { CommandProvider, createCommandRegistry } from '../../palette/commands';
import { ShortcutProvider } from '../../shortcuts/react';
import { UpdatesProvider } from '../../updates/context';
import type { UpdatesClient } from '../../updates/updates';
import { Conversations } from './Conversations';
import { askAres, CONVERSATIONS_REVEAL, type ConversationsClient } from './conversations';
import { WhatAresCanDo } from './WhatAresCanDo';

// Conversations (#191) in the Ares Section, with the Core's own Conversations behind the window's
// channel and a model the test writes token by token.

type Call = { write(token: string): void; finish(): void };

let store: ItemStore;
let close: () => void;
let core: CoreConversations;
let client: ConversationsClient;
let calls: Call[];
let refuse: ModelError | null;
// What the call that keeps what the User tells him answers (#194); none: it fails.
let learnReply: string | null;
const listeners = new Set<(message: CoreMessage) => void>();
const onCoreMessage = (listener: (message: CoreMessage) => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const provider: ModelProviderAdapter = {
  send: () =>
    learnReply === null
      ? Promise.reject(new Error('Conversations stream'))
      : Promise.resolve({ text: learnReply, usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 } }),
  stream(request, onToken) {
    if (refuse) return Promise.reject(refuse);
    return new Promise<ProviderReply>((resolve, reject) => {
      let text = '';
      request.signal?.addEventListener('abort', () => reject(new ModelError('cancelled', 'Cancelled.')));
      calls.push({
        write(token) {
          text += token;
          onToken(token);
        },
        finish: () => resolve({ text, usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 } }),
      });
    });
  },
};

beforeEach(() => {
  ({ store, close } = openTestItemStore());
  calls = [];
  refuse = null;
  learnReply = null;
  boot();
});

// The Core's Conversations behind the window's channel, with these Skills (#192) or none, and
// remembering what the User tells Ares (#194) when asked.
function boot(skills?: SkillRegistry, { remember = false }: { remember?: boolean } = {}) {
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const model = createModelClient({
    settings: () => store.models.settings(),
    providers: { zai: provider },
    ledger: store.models,
  });
  core = setUpConversations({
    skills,
    item: (itemId) => store.get(itemId)?.item ?? null,
    store: store.conversations,
    client: model,
    ...(remember && {
      remember: createRememberer({
        client: model,
        memory: store.memory,
        projects: () => store.projects(),
        people: () => store.people.list(),
        item: (itemId) => store.get(itemId)?.item ?? null,
        log: () => {},
      }),
    }),
    settings: () => store.models.settings(),
    oneAtATime: () => false,
    log: () => {},
    send(message) {
      const reply = message as {
        type: string;
        id: number;
        response: { ok: boolean; result?: unknown; error?: string };
      };
      if (reply.type === CONVERSATIONS_MESSAGES.reply) {
        const waiting = pending.get(reply.id);
        pending.delete(reply.id);
        if (reply.response.ok) waiting?.resolve(reply.response.result);
        else waiting?.reject(new Error(reply.response.error));
        return;
      }
      for (const listener of listeners) act(() => listener(message as CoreMessage));
    },
  });
  let id = 0;
  client = ((request) =>
    new Promise<unknown>((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      core.handle({ type: CONVERSATIONS_MESSAGES.request, id, request });
    })) as ConversationsClient;
}

afterEach(() => {
  cleanup();
  core.stop();
  listeners.clear();
  close();
});

function show() {
  render(<Conversations client={client} shown onCoreMessage={onCoreMessage} />);
}

const input = () => screen.getByRole('textbox', { name: 'Message Ares' });
const thread = () => screen.getByTestId('conversation-thread');

async function type(text: string) {
  await waitFor(() => expect((input() as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.change(input(), { target: { value: text } });
  fireEvent.keyDown(input(), { key: 'Enter' });
}

describe('Conversations in the Ares Section', () => {
  it('lands on today’s Conversation; Enter sends, his answer streams in, and is marked as his own knowledge', async () => {
    show();
    await waitFor(() => expect(within(thread()).getByRole('heading', { name: 'Today' })).toBeTruthy());
    await type('How do tides work?');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(within(thread()).getAllByTestId('conversation-turn')[0]).toHaveProperty(
      'textContent',
      'How do tides work?',
    );
    expect(input()).toHaveProperty('value', '');
    // Answering: Send became Stop.
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();

    act(() => calls[0]?.write('[general]\nThe Moon’s pull'));
    await waitFor(() => expect(screen.getByTestId('ares-answer').textContent).toBe('The Moon’s pull'));
    act(() => {
      calls[0]?.write(' raises the sea.');
      calls[0]?.finish();
    });
    await waitFor(() =>
      expect(screen.getByTestId('own-knowledge').textContent).toBe('From Ares’s own knowledge'),
    );
    expect(screen.getByTestId('ares-answer').textContent).toBe('The Moon’s pull raises the sea.');
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    // Named from the first words the User wrote.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('conversation-list')).getByRole('listitem', { name: 'How do tides work?' }),
      ).toBeTruthy(),
    );
  });

  it('Stop ends his answer early and keeps what he wrote', async () => {
    show();
    await type('Tell me a long story');
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => calls[0]?.write('[general]\nOnce upon a time'));
    await waitFor(() => expect(screen.getByTestId('ares-answer').textContent).toBe('Once upon a time'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(within(thread()).getByText('Stopped')).toBeTruthy());
    expect(screen.getByTestId('ares-answer').textContent).toBe('Once upon a time');
  });

  it('says why he couldn’t answer, keeps the User’s message, and Send again asks once more', async () => {
    refuse = new ModelError('no-key', 'No key.');
    show();
    await type('Hello?');
    await waitFor(() => expect(screen.getByTestId('ares-problem').textContent).toMatch(/no model key saved/));
    expect(within(thread()).getAllByTestId('conversation-turn')[0]?.textContent).toBe('Hello?');
    refuse = null;
    fireEvent.click(screen.getByRole('button', { name: 'Send again' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByTestId('ares-problem')).toBeNull();
  });

  it('ends an answer with a plain failure when the Core stops while writing it, keeping the User’s message (#200)', async () => {
    // The window's channel outlives the Core: it reaches whichever Core is running.
    render(
      <Conversations
        client={((request) => client(request)) as ConversationsClient}
        shown
        onCoreMessage={onCoreMessage}
      />,
    );
    await type('Tell me a long story');
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => calls[0]?.write('[general]\nOnce upon a time'));
    await waitFor(() => expect(screen.getByTestId('ares-answer').textContent).toBe('Once upon a time'));

    // The Core stops without closing, a new one starts on the same database, and main says so.
    boot();
    for (const listener of listeners) act(() => listener({ type: 'core-restarted', at: 1 }));
    await waitFor(() => expect(screen.getByTestId('ares-problem').textContent).toBe(UNFINISHED_PROBLEM));
    expect(within(thread()).getAllByTestId('conversation-turn')[0]?.textContent).toBe('Tell me a long story');
    fireEvent.click(screen.getByRole('button', { name: 'Send again' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(screen.queryByTestId('ares-problem')).toBeNull();
  });

  it('starts a New Conversation beside today’s, each keeping its own unsent words', async () => {
    show();
    await waitFor(() => expect(within(thread()).getByRole('heading', { name: 'Today' })).toBeTruthy());
    fireEvent.change(input(), { target: { value: 'half a thought' } });
    fireEvent.click(screen.getByRole('button', { name: 'New Conversation' }));
    await waitFor(() =>
      expect(within(thread()).getByRole('heading', { name: 'New Conversation' })).toBeTruthy(),
    );
    expect(input()).toHaveProperty('value', '');
    const list = screen.getByTestId('conversation-list');
    await waitFor(() => expect(within(list).getAllByTestId('conversation-row')).toHaveLength(2));
    fireEvent.click(
      within(within(list).getByRole('listitem', { name: 'Today' })).getByRole('button', { name: /^Today/ }),
    );
    await waitFor(() => expect(input()).toHaveProperty('value', 'half a thought'));
  });
});

describe('from Ctrl+K (#195)', () => {
  it('Ask Ares starts a new Conversation with what was typed as its first message, opened here', async () => {
    show();
    await waitFor(() => expect(within(thread()).getByRole('heading', { name: 'Today' })).toBeTruthy());
    const { conversationId, problem } = await askAres(client, 'How do tides work?', '2026-10-06');
    expect(problem).toBeNull();
    act(() => requestReveal(CONVERSATIONS_REVEAL, conversationId));
    await waitFor(() =>
      expect(within(thread()).getByRole('heading', { name: 'How do tides work?' })).toBeTruthy(),
    );
    expect(within(thread()).getAllByTestId('conversation-turn')[0]?.textContent).toBe('How do tides work?');
    await waitFor(() => expect(calls).toHaveLength(1));
  });

  it('opens a Conversation search found at the turn that matched, marked', async () => {
    const { conversation } = store.conversations.create('2026-10-05');
    const asked = store.conversations.addUserTurn(conversation.id, 'What is a fjord?');
    const answer = store.conversations.startAnswer(conversation.id, asked.id, 'streaming');
    store.conversations.saveAnswer(answer.id, { status: 'done', text: 'Carved by glaciers.', endedAt: 1 });
    show();
    await waitFor(() => expect(within(thread()).getByRole('heading', { name: 'Today' })).toBeTruthy());
    act(() => requestReveal(CONVERSATIONS_REVEAL, conversation.id, String(answer.id)));
    await waitFor(() =>
      expect(within(thread()).getByRole('heading', { name: 'What is a fjord?' })).toBeTruthy(),
    );
    const [first, second] = within(thread()).getAllByTestId('conversation-turn');
    expect(second?.dataset.found).toBe('true');
    expect(first?.dataset.found).toBeUndefined();
  });
});

describe('what Ares remembers from what the User tells him (#194)', () => {
  it('says so under his answer, with an Undo that takes it back', async () => {
    core.stop();
    boot(undefined, { remember: true });
    learnReply = JSON.stringify({
      remember: [
        {
          kind: 'preference',
          text: 'The User doesn’t take meetings before 10',
          said: 'you don’t take meetings before 10',
        },
      ],
      forget: [],
    });
    show();
    await type('I don’t take meetings before 10');
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => {
      calls[0]?.write('[chat]\nNoted.');
      calls[0]?.finish();
    });
    const line = await screen.findByTestId('remembered');
    expect(line.textContent).toMatch(/^I’ll remember that you don’t take meetings before 10\.Undo$/);
    expect(store.memory.list().memories.map((memory) => memory.text)).toEqual([
      'The User doesn’t take meetings before 10',
    ]);

    fireEvent.click(within(line).getByRole('button', { name: /^Undo/ }));
    await waitFor(() => expect(screen.getByTestId('remembered').getAttribute('data-undone')).toBe('true'));
    expect(within(screen.getByTestId('remembered')).getByText('Undone')).toBeTruthy();
    expect(store.memory.list().memories).toEqual([]);
  });
});

// The Update the fake Update Skill gives, as the Core keeps it, and what the window asked of Updates.
const queuedLine = (status: QueuedLine['status']): QueuedLine => ({
  id: 3,
  group: 'decision',
  mergeKey: 'suggestions:3',
  about: {
    kind: 'suggestions',
    action: 'suggest-todos',
    name: 'Suggest Todos',
    actionKind: 'organise',
    proposalIds: [3],
  },
  itemIds: ['block-3'],
  section: 'notes',
  importance: 0.6,
  createdAt: 1,
  updatedAt: 1,
  expiresAt: null,
  snoozedUntil: null,
  status,
  settledAt: null,
});
const givenUpdate = (status: QueuedLine['status']): UpdateView => ({
  id: 5,
  at: new Date(2026, 9, 6, 9, 0).getTime(),
  awayMs: 0,
  folded: false,
  voice: 'template',
  lines: [
    {
      queuedId: 3,
      group: 'decision',
      kind: 'suggestions',
      text: 'One Todo I wasn’t sure about: Send Dana the Q3 numbers.',
      itemIds: ['block-3'],
      section: 'notes',
      sources: [],
      folded: false,
      fresh: true,
      queued: queuedLine(status),
      rows: [],
    },
  ],
});

describe('Ares’s Skills in a Conversation (#192)', () => {
  let opened: unknown[];
  let updateRequests: UpdatesRequest[];
  let lineStatus: QueuedLine['status'];
  const updates = (async (request: UpdatesRequest) => {
    updateRequests.push(request);
    if (request.op === 'act') lineStatus = 'done';
    if (request.op === 'past') return givenUpdate(lineStatus);
    if (request.op === 'state') return { queued: 1, presence: { state: 'active', since: 1 } };
    return null;
  }) as UpdatesClient;

  beforeEach(() => {
    opened = [];
    updateRequests = [];
    lineStatus = 'queued';
  });

  function showWithSkills(registry: SkillRegistry) {
    core.stop();
    boot(registry);
    render(
      <ShortcutProvider>
        <CommandProvider registry={createCommandRegistry()}>
          <UpdatesProvider client={updates} onOpen={(target) => opened.push(target)}>
            <Conversations client={client} shown onCoreMessage={onCoreMessage} />
            <WhatAresCanDo client={client} shown />
          </UpdatesProvider>
        </CommandProvider>
      </ShortcutProvider>,
    );
  }

  it('says what he is doing while Find runs, then links what his answer rests on, each opening in its Section', async () => {
    const blockId = writeBlock(store, '2026-10-05', 'Acme kickoff notes');
    const registry = createSkillRegistry();
    registry.register(createFindSkill({ itemStore: store }));
    showWithSkills(registry);
    await type('Where are my Acme notes?');
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => {
      calls[0]?.write('[skill]\n{"skill":"find","input":{"query":"acme"}}');
      calls[0]?.finish();
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    // Nothing of his Skill request shows; what he is doing does.
    expect(screen.getByTestId('ares-doing').textContent).toBe('Looking it up…');
    expect(screen.queryByTestId('ares-answer')).toBeNull();
    act(() => {
      calls[1]?.write('[their-data]\nThey’re in Monday’s Daily Note [I1].');
      calls[1]?.finish();
    });
    const link = await screen.findByRole('button', { name: 'Open Acme kickoff notes' });
    expect(screen.getByTestId('ares-answer').textContent).toBe(
      'They’re in Monday’s Daily Note Acme kickoff notes.',
    );
    expect(screen.queryByTestId('own-knowledge')).toBeNull();
    fireEvent.click(link);
    expect(opened).toEqual([{ kind: 'item', sectionId: 'notes', itemId: blockId }]);
  });

  it('shows the Update he gave when asked in words, with its lines and actions, as the panel does', async () => {
    const registry = createSkillRegistry();
    registry.register({ ...UPDATE_SKILL, run: async () => givenUpdate('queued') });
    showWithSkills(registry);
    await type('Anything I should know?');
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => {
      calls[0]?.write('[skill]\n{"skill":"update","input":{}}');
      calls[0]?.finish();
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    act(() => {
      calls[1]?.write('[their-data]\nOne thing waits on you.');
      calls[1]?.finish();
    });
    const shown = await screen.findByTestId('conversation-update');
    expect(within(shown).getByTestId('update-line').textContent).toContain('Send Dana the Q3 numbers');
    fireEvent.click(within(shown).getByRole('button', { name: 'Open' }));
    expect(opened).toEqual([{ kind: 'item', sectionId: 'notes', itemId: 'block-3' }]);
    fireEvent.click(within(shown).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(within(shown).getByTestId('update-line-status').textContent).toBe('Done'));
    expect(updateRequests).toContainEqual({ op: 'act', queuedId: 3, action: 'done' });
  });

  it('lists every Skill he has on What Ares can do, with how to ask for each', async () => {
    const registry = createSkillRegistry();
    registry.register(createFindSkill({ itemStore: store }));
    registry.register({ ...UPDATE_SKILL, run: async () => null });
    registry.register({ ...DRAFT_SKILL, run: async () => null });
    showWithSkills(registry);
    const page = screen.getByTestId('what-ares-can-do');
    await waitFor(() => expect(within(page).getAllByTestId('ares-skill')).toHaveLength(3));
    const find = within(page).getByRole('listitem', { name: 'Find' });
    expect(find.textContent).toContain(FIND_SKILL.summary);
    expect(within(find).getByTestId('ares-skill-example').textContent).toBe(
      'Ask: “Find the email about the Acme redlines”',
    );
    expect(within(page).getByRole('listitem', { name: 'Update' }).textContent).toContain(
      'Ask: “Anything I should know?”',
    );
    expect(within(page).getByRole('listitem', { name: 'Draft' }).textContent).toContain(
      'Not in Conversations yet',
    );
  });
});
