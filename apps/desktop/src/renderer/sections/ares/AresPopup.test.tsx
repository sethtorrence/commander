// @vitest-environment jsdom

import {
  type Conversations as CoreConversations,
  setUpConversations,
} from '@commander/core/src/conversations';
import { createAboutReader } from '@commander/core/src/conversations/about';
import type { ItemStore } from '@commander/core/src/item-store';
import { CONVERSATIONS_MESSAGES, type CoreMessage, type Item } from '@commander/domain';
import {
  createModelClient,
  ModelError,
  type ModelProviderAdapter,
  type ProviderReply,
  type ProviderRequest,
} from '@commander/models';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestReveal } from '../../frame/reveal';
import { openTestItemStore } from '../../item-store/test-item-store';
import { AskAres, useAresKey } from '../../links/AresButton';
import { ShortcutProvider, useShortcuts } from '../../shortcuts/react';
import { AresPopupHost, placeBeside } from './AresPopup';
import { Conversations } from './Conversations';
import { CONVERSATIONS_REVEAL, type ConversationsClient } from './conversations';

// The Ares button's pop-up (#193): a new Conversation about an Item, with the Core's own
// Conversations behind the window's channel and a model the test writes token by token.

type Call = { request: ProviderRequest; write(token: string): void; finish(): void };

let store: ItemStore;
let close: () => void;
let core: CoreConversations;
let client: ConversationsClient;
let calls: Call[];
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
    return new Promise<ProviderReply>((resolve, reject) => {
      let text = '';
      request.signal?.addEventListener('abort', () => reject(new ModelError('cancelled', 'Cancelled.')));
      calls.push({
        request,
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
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  core = setUpConversations({
    item: (itemId) => store.get(itemId)?.item ?? null,
    readAbout: createAboutReader({ itemStore: store }),
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

function todo(title: string): Item {
  const { itemId } = store.record(
    {
      type: 'create',
      item: { kind: 'todo', title, detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null } },
    },
    { by: { kind: 'user' } },
  );
  return store.get(itemId)?.item as Item;
}

// A row standing in for a Section's: it opens on a click, and has the Ares button; `a` asks about it.
function Row({ item, onOpen }: { item: Item; onOpen?: () => void }) {
  useShortcuts([useAresKey(item)]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a stand-in for a row that opens on a click
    <li aria-label={item.title} onClick={onOpen}>
      {item.title}
      <AskAres item={item} />
    </li>
  );
}

function show(item: Item, options: { onExpand?: (id: string) => void; onOpen?: () => void } = {}) {
  render(
    <ShortcutProvider>
      <AresPopupHost client={client} onCoreMessage={onCoreMessage} onExpand={options.onExpand ?? (() => {})}>
        <ul>
          <Row item={item} onOpen={options.onOpen} />
        </ul>
      </AresPopupHost>
    </ShortcutProvider>,
  );
}

const popup = () => screen.getByTestId('ares-popup');
const input = () => within(popup()).getByRole('textbox', { name: 'Message Ares' });

describe('the Ares button’s pop-up', () => {
  it('opens beside the Item with nothing made yet; the first message starts a Conversation holding the Item, and his answer streams in', async () => {
    const book = todo('Book flights for the offsite');
    const onOpen = vi.fn();
    show(book, { onOpen });

    fireEvent.click(screen.getByRole('button', { name: 'Ask Ares about Book flights for the offsite' }));
    // The row didn't open; the pop-up names its Item and waits for the User.
    expect(onOpen).not.toHaveBeenCalled();
    expect(popup().getAttribute('aria-label')).toBe('Ares on Book flights for the offsite');
    expect(within(popup()).getByTestId('ares-popup-about').textContent).toBe(
      'TDOBook flights for the offsite',
    );
    expect(document.activeElement).toBe(input());
    expect(store.conversations.list()).toEqual([]);

    fireEvent.change(input(), { target: { value: 'What should I do first?' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(calls).toHaveLength(1));
    // A new Conversation, named after the Item, which went to Ares as the User's own.
    const [made] = store.conversations.list();
    expect(made).toMatchObject({ title: 'Book flights for the offsite', aboutItemId: book.id, daily: false });
    expect(calls[0]?.request.messages.at(-1)?.content).toMatch(
      /ref="I1" label="I1 · Todo · Book flights for the offsite" source="the User">/,
    );
    expect(input()).toHaveProperty('value', '');

    act(() => calls[0]?.write('[their-data]\nCompare fares'));
    await waitFor(() => expect(within(popup()).getByTestId('ares-answer').textContent).toBe('Compare fares'));
    act(() => {
      calls[0]?.write(' first [I1].');
      calls[0]?.finish();
    });
    await waitFor(() =>
      expect(within(popup()).getByTestId('ares-answer').textContent).toBe(
        'Compare fares first Book flights for the offsite.',
      ),
    );
    // His link opens the Todo where it lives.
    expect(within(popup()).getByRole('button', { name: 'Open Book flights for the offsite' })).toBeTruthy();
  });

  it('starts with a suggested question one click away', async () => {
    show(todo('Call the bank'));
    fireEvent.click(screen.getByRole('button', { name: 'Ask Ares about Call the bank' }));
    fireEvent.click(within(popup()).getByRole('button', { name: 'What’s this about?' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.request.messages.at(-2)).toEqual({ role: 'user', content: 'What’s this about?' });
  });

  it('a opens it on the focused Item, Esc closes it, and the Conversation stays saved', async () => {
    show(todo('Call the bank'));
    fireEvent.keyDown(window, { key: 'a' });
    expect(popup()).toBeTruthy();
    fireEvent.change(input(), { target: { value: 'Which bank?' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => {
      calls[0]?.write('[chat]\nYours.');
      calls[0]?.finish();
    });
    await waitFor(() => expect(within(popup()).getByTestId('ares-answer').textContent).toBe('Yours.'));

    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(screen.queryByTestId('ares-popup')).toBeNull();
    expect(store.conversations.list().map((each) => each.title)).toEqual(['Call the bank']);
    // Pressed again, it starts afresh.
    fireEvent.click(screen.getByRole('button', { name: 'Ask Ares about Call the bank' }));
    expect(within(popup()).queryAllByTestId('conversation-turn')).toHaveLength(0);
  });

  it('Esc closes it from outside it too, before the page hears the key', () => {
    const page = vi.fn();
    window.addEventListener('keydown', page);
    show(todo('Call the bank'));
    fireEvent.click(screen.getByRole('button', { name: 'Ask Ares about Call the bank' }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByTestId('ares-popup')).toBeNull();
    expect(page).not.toHaveBeenCalled();
    window.removeEventListener('keydown', page);
  });

  it('Open in Ares moves the same Conversation into the Ares Section, where it carries on', async () => {
    const book = todo('Book flights for the offsite');
    render(
      <ShortcutProvider>
        <AresPopupHost
          client={client}
          onCoreMessage={onCoreMessage}
          onExpand={(id) => requestReveal(CONVERSATIONS_REVEAL, id)}
        >
          <ul>
            <Row item={book} />
          </ul>
          <Conversations client={client} shown onCoreMessage={onCoreMessage} />
        </AresPopupHost>
      </ShortcutProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ask Ares about Book flights for the offsite' }));
    fireEvent.change(input(), { target: { value: 'What should I do first?' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(calls).toHaveLength(1));
    const [made] = store.conversations.list();

    fireEvent.click(within(popup()).getByRole('button', { name: 'Open in Ares' }));
    await waitFor(() => expect(screen.queryByTestId('ares-popup')).toBeNull());
    const thread = screen.getByTestId('conversation-thread');
    await waitFor(() =>
      expect(within(thread).getByRole('heading', { name: 'Book flights for the offsite' })).toBeTruthy(),
    );
    expect(within(thread).getByTestId('conversation-about').textContent).toBe(
      'AboutTDOBook flights for the offsite',
    );
    // He finishes there, in the same Conversation, which is listed.
    act(() => {
      calls[0]?.write('[their-data]\nCompare fares.');
      calls[0]?.finish();
    });
    await waitFor(() => expect(within(thread).getByTestId('ares-answer').textContent).toBe('Compare fares.'));
    expect(
      within(screen.getByTestId('conversation-list')).getByRole('listitem', {
        name: 'Book flights for the offsite',
      }),
    ).toBeTruthy();
    expect(store.conversations.list().map((each) => each.id)).toContain(made?.id);
  });
});

describe('where the pop-up stands', () => {
  const view = { width: 1600, height: 900 };

  it('to the right of the button, or to its left when there is no room', () => {
    expect(placeBeside({ left: 200, right: 220, top: 300 }, view)).toEqual({ left: 228, top: 286 });
    expect(placeBeside({ left: 1500, right: 1520, top: 300 }, view)).toEqual({ left: 1092, top: 286 });
  });

  it('within the window, and at its right when opened with no button on screen', () => {
    expect(placeBeside({ left: 200, right: 220, top: 880 }, view).top).toBe(900 - 480 - 12);
    expect(placeBeside(null, view)).toEqual({ left: 1600 - 400 - 24, top: 900 - 480 - 24 });
  });
});
