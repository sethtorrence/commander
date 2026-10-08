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
import { CheatSheet } from '../../frame/CheatSheet';
import { openTestItemStore } from '../../item-store/test-item-store';
import { CommandProvider, createCommandRegistry } from '../../palette/commands';
import { ShortcutProvider } from '../../shortcuts/react';
import { UpdatesProvider } from '../../updates/context';
import type { OpenTarget } from '../../updates/updates';
import { AresPanel } from './AresPanel';
import { type ConversationsClient, openConversation } from './conversations';
import {
  loadPanelLayout,
  MIN_PANEL_WIDTH,
  PANEL_STORAGE_KEY,
  PANEL_WIDTH,
  panelWidth,
  usePanelLayout,
} from './panel-layout';

// The Ares panel (#235): Conversations beside every Section, with the Core's own Conversations behind
// the window's channel and a model the test writes token by token.

type Call = { write(token: string): void; finish(): void };

let store: ItemStore;
let close: () => void;
let core: CoreConversations;
let client: ConversationsClient;
let calls: Call[];
let storage: Storage;
let opened: OpenTarget[];
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
        write(token) {
          text += token;
          onToken(token);
        },
        finish: () => resolve({ text, usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 } }),
      });
    });
  },
};

// The window's own storage, as a restart finds it.
function memoryStorage(): Storage {
  const kept = new Map<string, string>();
  return {
    get length() {
      return kept.size;
    },
    clear: () => kept.clear(),
    getItem: (key) => kept.get(key) ?? null,
    key: (index) => [...kept.keys()][index] ?? null,
    removeItem: (key) => {
      kept.delete(key);
    },
    setItem: (key, value) => {
      kept.set(key, value);
    },
  };
}

beforeEach(() => {
  // A window as wide as the author's.
  Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
  ({ store, close } = openTestItemStore());
  calls = [];
  opened = [];
  storage = memoryStorage();
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const model = createModelClient({
    settings: () => store.models.settings(),
    providers: { zai: provider },
    ledger: store.models,
  });
  core = setUpConversations({
    item: (itemId) => store.get(itemId)?.item ?? null,
    store: store.conversations,
    client: model,
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

// The frame's part: the panel's layout, the header's AI mark, and a Section beside it.
function Frame() {
  const layout = usePanelLayout(storage);
  return (
    <>
      <button type="button" aria-label="Ares panel" aria-pressed={layout.open} onClick={layout.toggle} />
      <main>
        <button type="button">A row in the Section</button>
      </main>
      <AresPanel
        layout={layout}
        client={client}
        onCoreMessage={onCoreMessage}
        onFullView={(conversationId) => opened.push({ kind: 'section', sectionId: `ares:${conversationId}` })}
      />
    </>
  );
}

function show() {
  return render(
    <ShortcutProvider>
      <CommandProvider registry={createCommandRegistry()}>
        <UpdatesProvider client={undefined} onOpen={(target) => opened.push(target)}>
          <Frame />
        </UpdatesProvider>
      </CommandProvider>
    </ShortcutProvider>,
  );
}

const panel = () => screen.getByTestId('ares-panel');
const input = () => within(panel()).getByRole('textbox', { name: 'Message Ares' }) as HTMLTextAreaElement;
const heading = (name: string) => within(panel()).getByRole('heading', { name });
const row = (name: string) =>
  within(within(panel()).getByTestId('conversation-list')).getByRole('listitem', { name });
const ctrlJ = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'j', ctrlKey: true });
const saved = () => loadPanelLayout(storage);

async function type(text: string) {
  await waitFor(() => expect(input().disabled).toBe(false));
  fireEvent.change(input(), { target: { value: text } });
  fireEvent.keyDown(input(), { key: 'Enter' });
}

describe('the Ares panel', () => {
  it('opens and closes with Ctrl+J and the header’s mark; Esc in it hands the focus back to the Section', async () => {
    show();
    expect(panel().hidden).toBe(true);
    const sectionRow = screen.getByRole('button', { name: 'A row in the Section' });
    sectionRow.focus();

    ctrlJ();
    expect(panel().hidden).toBe(false);
    await waitFor(() => expect(heading('Today')).toBeTruthy());
    // The box takes the focus once today's Conversation is there.
    await waitFor(() => expect(document.activeElement).toBe(input()));
    expect(document.documentElement.style.getPropertyValue('--panel')).toBe(`${PANEL_WIDTH}px`);

    // Esc: back to the Section, the panel stays.
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(document.activeElement).toBe(sectionRow);
    expect(panel().hidden).toBe(false);

    // Ctrl+J from a field in the panel closes it, the focus going back to the Section.
    input().focus();
    ctrlJ();
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(sectionRow);
    expect(document.documentElement.style.getPropertyValue('--panel')).toBe('0px');

    // The header's mark does the same.
    fireEvent.click(screen.getByRole('button', { name: 'Ares panel' }));
    expect(panel().hidden).toBe(false);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Close the Ares panel' }));
    expect(panel().hidden).toBe(true);
  });

  it('lists its key in the cheat sheet and the palette’s commands', () => {
    const commands = createCommandRegistry();
    render(
      <ShortcutProvider>
        <CommandProvider registry={commands}>
          <Frame />
          <CheatSheet open onOpenChange={() => {}} />
        </CommandProvider>
      </ShortcutProvider>,
    );
    const general = screen.getByRole('region', { name: 'General' });
    expect(
      within(general).getByText('Open or close the Ares panel').previousElementSibling?.textContent,
    ).toBe('CtrlJ');
    expect(commands.list().find((command) => command.keys === 'Ctrl+j')?.label).toBe(
      'Open or close the Ares panel',
    );
  });

  it('runs two Conversations at once: switching between them stops neither, and the list says which answer', async () => {
    show();
    ctrlJ();
    await waitFor(() => expect(heading('Today')).toBeTruthy());
    await type('Tell me a long story');
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => calls[0]?.write('[general]\nOnce upon'));
    await waitFor(() => expect(within(panel()).getByTestId('ares-answer').textContent).toBe('Once upon'));

    // A second one while he writes the first.
    fireEvent.click(within(panel()).getByRole('button', { name: 'New Conversation' }));
    await waitFor(() => expect(heading('New Conversation')).toBeTruthy());
    await type('What is 2 + 2?');
    await waitFor(() => expect(calls).toHaveLength(2));
    act(() => {
      calls[0]?.write(' a time');
      calls[1]?.write('[general]\n4');
    });
    await waitFor(() => expect(within(panel()).getByTestId('ares-answer').textContent).toBe('4'));
    await waitFor(() => expect(row('Tell me a long story').dataset.state).toBe('answering'));
    expect(row('What is 2 + 2?').dataset.state).toBe('answering');
    expect(within(row('Tell me a long story')).getByTestId('conversation-state').textContent).toBe(
      'Answering',
    );

    // Back to the first: everything he wrote meanwhile is there, and he carries on.
    fireEvent.click(
      within(row('Tell me a long story')).getByRole('button', { name: /^Tell me a long story/ }),
    );
    await waitFor(() => expect(heading('Tell me a long story')).toBeTruthy());
    expect(within(panel()).getByTestId('ares-answer').textContent).toBe('Once upon a time');
    act(() => {
      calls[0]?.write(' there was a fjord.');
      calls[0]?.finish();
      calls[1]?.write('.');
      calls[1]?.finish();
    });
    await waitFor(() =>
      expect(within(panel()).getByTestId('ares-answer').textContent).toBe(
        'Once upon a time there was a fjord.',
      ),
    );
    expect(within(panel()).getAllByTestId('conversation-turn')[1]?.dataset.status).toBe('done');
    await waitFor(() => expect(row('What is 2 + 2?').dataset.state).toBe('idle'));
    expect(row('Tell me a long story').dataset.state).toBe('idle');
    expect(store.conversations.list().map((each) => each.answering)).toEqual([false, false]);
  });

  it('says in the list which Conversation has a card waiting for the User and which didn’t finish', async () => {
    const failing = store.conversations.create('2026-10-05').conversation;
    const asked = store.conversations.addUserTurn(failing.id, 'What is a fjord?');
    const failed = store.conversations.startAnswer(failing.id, asked.id, 'streaming');
    store.conversations.saveAnswer(failed.id, { status: 'failed', problem: 'No key.', endedAt: 1 });
    const asking = store.conversations.create('2026-10-05').conversation;
    const add = store.conversations.addUserTurn(asking.id, 'Add a Todo to book flights');
    const answer = store.conversations.startAnswer(asking.id, add.id, 'streaming');
    store.conversations.saveAnswer(answer.id, { status: 'done', text: 'Shall I?', endedAt: 2 });
    const todo = store.record(
      { type: 'create', item: { kind: 'todo', title: 'Book flights' } },
      { by: { kind: 'user' } },
    ).itemId;
    const proposal = store.autonomy.saveProposal({
      actionKind: 'organise',
      action: 'manage-todos',
      section: null,
      itemId: todo,
      itemActions: [],
      confidence: 1,
      reason: 'You asked in a Conversation',
      causedBy: null,
      chained: false,
      conversation: { conversationId: asking.id, turnId: answer.id },
      decision: 'ask',
      status: 'pending',
      entryIds: [],
    });
    show();
    ctrlJ();
    await waitFor(() => expect(row('What is a fjord?').dataset.state).toBe('failed'));
    expect(within(row('What is a fjord?')).getByTestId('conversation-state').textContent).toBe(
      'Didn’t finish',
    );
    expect(row('Add a Todo to book flights').dataset.state).toBe('waiting');
    expect(within(row('Add a Todo to book flights')).getByTestId('conversation-state').textContent).toBe(
      'Waiting for you',
    );

    // The User dismisses the card (the gate says Ares's activity changed).
    store.autonomy.settleProposal(proposal.id, { status: 'dismissed', entryIds: [] });
    for (const listener of listeners) act(() => listener({ type: 'ares-activity', at: 3 }));
    await waitFor(() => expect(row('Add a Todo to book flights').dataset.state).toBe('idle'));
  });

  it('keeps its open state, width and Conversation across Sections and a restart', async () => {
    const first = show();
    ctrlJ();
    await waitFor(() => expect(heading('Today')).toBeTruthy());
    fireEvent.click(within(panel()).getByRole('button', { name: 'New Conversation' }));
    await waitFor(() => expect(heading('New Conversation')).toBeTruthy());
    await type('Where did the offsite land?');
    await waitFor(() => expect(heading('Where did the offsite land?')).toBeTruthy());
    act(() => {
      calls[0]?.write('[general]\nLisbon.');
      calls[0]?.finish();
    });

    // Wider by dragging its edge, and with the arrow keys on it.
    const edge = within(panel()).getByRole('separator', { name: 'Resize the Ares panel' });
    fireEvent.pointerDown(edge, { clientX: 1000, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 900, pointerId: 1 });
    fireEvent.pointerUp(edge, { clientX: 900, pointerId: 1 });
    expect(panel().style.width).toBe(`${PANEL_WIDTH + 100}px`);
    fireEvent.keyDown(edge, { key: 'ArrowLeft' });
    expect(panel().style.width).toBe(`${PANEL_WIDTH + 116}px`);
    const conversationId = store.conversations.list().find((each) => each.title)?.id;
    expect(saved()).toEqual({ open: true, width: PANEL_WIDTH + 116, conversationId });

    // Restarted: open, as wide, on the same Conversation with what was said.
    first.unmount();
    show();
    expect(panel().hidden).toBe(false);
    expect(panel().style.width).toBe(`${PANEL_WIDTH + 116}px`);
    await waitFor(() => expect(heading('Where did the offsite land?')).toBeTruthy());
    expect(within(panel()).getByTestId('ares-answer').textContent).toBe('Lisbon.');

    // Closed, it stays closed.
    ctrlJ();
    expect(saved().open).toBe(false);
  });

  it('opens on today’s Conversation when the one it had is gone', async () => {
    storage.setItem(PANEL_STORAGE_KEY, JSON.stringify({ open: true, width: 300, conversationId: 'gone' }));
    show();
    await waitFor(() => expect(heading('Today')).toBeTruthy());
    // Never narrower than its limit.
    expect(panel().style.width).toBe(`${MIN_PANEL_WIDTH}px`);
  });

  it('opens a Conversation asked for from elsewhere, at its turn, and keeps the panel open as a link opens its Item', async () => {
    const todo = store.record(
      { type: 'create', item: { kind: 'todo', title: 'Book flights' } },
      { by: { kind: 'user' } },
    ).itemId;
    const { conversation } = store.conversations.create('2026-10-05');
    const asked = store.conversations.addUserTurn(conversation.id, 'What should I do next?');
    const answer = store.conversations.startAnswer(conversation.id, asked.id, 'streaming');
    store.conversations.saveAnswer(answer.id, {
      status: 'done',
      text: 'Book the flights [I1].',
      endedAt: 1,
      links: [
        { ref: 'I1', itemId: todo, kind: 'todo', title: 'Book flights', label: null, section: 'todos' },
      ],
    });
    show();
    expect(panel().hidden).toBe(true);

    act(() => openConversation(conversation.id, answer.id));
    expect(panel().hidden).toBe(false);
    await waitFor(() => expect(heading('What should I do next?')).toBeTruthy());
    const [first, second] = within(panel()).getAllByTestId('conversation-turn');
    expect(second?.dataset.found).toBe('true');
    expect(first?.dataset.found).toBeUndefined();

    // The link opens the Todo in its Section; the panel stays beside it.
    fireEvent.click(within(panel()).getByRole('button', { name: 'Open Book flights' }));
    expect(opened).toEqual([{ kind: 'item', sectionId: 'todos', itemId: todo }]);
    expect(panel().hidden).toBe(false);

    // Full view: the same Conversation, in the Ares Section.
    fireEvent.click(within(panel()).getByRole('button', { name: 'Full view' }));
    expect(opened.at(-1)).toEqual({ kind: 'section', sectionId: `ares:${conversation.id}` });
  });
});

describe('the panel’s width', () => {
  it('stays within its limits, and leaves the Section room on a narrow window', () => {
    expect(panelWidth(100, 1600)).toBe(MIN_PANEL_WIDTH);
    expect(panelWidth(500, 1600)).toBe(500);
    expect(panelWidth(2000, 1600)).toBe(760);
    expect(panelWidth(700, 1000)).toBe(440);
    expect(panelWidth(700, 700)).toBe(MIN_PANEL_WIDTH);
  });

  it('reads back as the default when nothing (or something unreadable) was kept', () => {
    expect(loadPanelLayout(storage)).toEqual({ open: false, width: PANEL_WIDTH, conversationId: null });
    storage.setItem(PANEL_STORAGE_KEY, '{not json');
    expect(loadPanelLayout(storage)).toEqual({ open: false, width: PANEL_WIDTH, conversationId: null });
  });
});
