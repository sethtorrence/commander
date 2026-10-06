// @vitest-environment jsdom
import {
  type Conversations as CoreConversations,
  setUpConversations,
} from '@commander/core/src/conversations';
import type { ItemStore } from '@commander/core/src/item-store';
import { CONVERSATIONS_MESSAGES, type CoreMessage } from '@commander/domain';
import {
  createModelClient,
  ModelError,
  type ModelProviderAdapter,
  type ProviderReply,
} from '@commander/models';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestItemStore } from '../../item-store/test-item-store';
import { Conversations } from './Conversations';
import type { ConversationsClient } from './conversations';

// Conversations (#191) in the Ares Section, with the Core's own Conversations behind the window's
// channel and a model the test writes token by token.

type Call = { write(token: string): void; finish(): void };

let store: ItemStore;
let close: () => void;
let core: CoreConversations;
let client: ConversationsClient;
let calls: Call[];
let refuse: ModelError | null;
const listeners = new Set<(message: CoreMessage) => void>();
const onCoreMessage = (listener: (message: CoreMessage) => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const provider: ModelProviderAdapter = {
  send: () => Promise.reject(new Error('Conversations stream')),
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
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  core = setUpConversations({
    store: store.conversations,
    client: createModelClient({
      settings: () => store.models.settings(),
      providers: { zai: provider },
      ledger: store.models,
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
});

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
