// @vitest-environment jsdom
import type {
  ConversationMade,
  ConversationsRequest,
  ConversationTurn,
  CoreMessage,
  QueuedLine,
  UpdatesRequest,
  UpdateView,
  UpdateViewLine,
} from '@commander/domain';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandProvider, createCommandRegistry } from '../../palette/commands';
import { ShortcutProvider } from '../../shortcuts/react';
import { UpdatesProvider } from '../../updates/context';
import type { OpenTarget, UpdatesClient } from '../../updates/updates';
import { AboutLine, LineActionCards } from './ConversationLine';
import type { ConversationsClient } from './conversations';

// A Conversation about an Update line (#236): the line under its title as it stands now, with the way
// back to its Update, and the line's actions Ares prepared as cards. Confirm does what the line's own
// button does (the Update's `act`), and only then says so; one key confirms it.

afterEach(cleanup);

const ABOUT = { updateId: 4, queuedId: 9 };

const queued = (overrides: Partial<QueuedLine> = {}): QueuedLine => ({
  id: 9,
  group: 'decision',
  mergeKey: 'linear-stuck:team-eng',
  about: {
    kind: 'linear-stuck',
    team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
    issues: [{ itemId: 'eng-7', identifier: 'ENG-7', reason: 'It sat in review', changedAt: 1 }],
  },
  itemIds: ['eng-7'],
  section: 'linear',
  importance: 0.5,
  createdAt: 1,
  updatedAt: 1,
  expiresAt: null,
  snoozedUntil: null,
  status: 'queued',
  settledAt: null,
  ...overrides,
});

const viewWith = (line: Partial<QueuedLine> = {}): UpdateView => ({
  id: 4,
  at: 1,
  awayMs: 0,
  folded: false,
  voice: 'template',
  lines: [
    {
      queuedId: 9,
      group: 'decision',
      kind: 'linear-stuck',
      text: 'ENG-7 “Ship the report” looks stuck.',
      itemIds: ['eng-7'],
      section: 'linear',
      sources: ['Ship the report'],
      folded: false,
      fresh: false,
      queued: queued(line),
      rows: [
        {
          itemId: 'eng-7',
          label: 'ENG-7',
          title: 'Ship the report',
          section: 'linear',
          state: 'In Review',
          quote: null,
          focus: null,
          actions: ['open', 'dismiss'],
          settled: null,
        },
      ],
    } satisfies UpdateViewLine,
  ],
});

const card = (
  overrides: Partial<Extract<ConversationMade, { kind: 'line-action' }>> = {},
): ConversationMade => ({
  kind: 'line-action',
  updateId: 4,
  queuedId: 9,
  itemId: null,
  action: 'dismiss',
  snooze: null,
  what: 'Dismiss the line',
  status: 'waiting',
  ...overrides,
});

const answer = (made: ConversationMade[], status: ConversationTurn['status'] = 'done'): ConversationTurn => ({
  id: 12,
  conversationId: 'c1',
  by: 'ares',
  text: 'It waits for you to confirm.',
  at: 1,
  status,
  replyTo: 11,
  ownKnowledge: false,
  problem: null,
  endedAt: 2,
  links: [],
  updateId: null,
  skills: ['line'],
  proposalIds: [],
  remembered: [],
  made,
});

let line: Partial<QueuedLine>;
let updatesAsked: UpdatesRequest[];
let conversationsAsked: ConversationsRequest[];
let opened: OpenTarget[];
let listeners: ((message: CoreMessage) => void)[];

const updates = vi.fn(async (request: UpdatesRequest) => {
  updatesAsked.push(request);
  if (request.op === 'past') return viewWith(line);
  if (request.op === 'act') {
    line = { status: request.action === 'dismiss' ? 'dismissed' : 'done', settledAt: 5 };
    return queued(line);
  }
  if (request.op === 'state') return { queued: 1, presence: { state: 'active', since: 1 } };
  return null;
}) as unknown as UpdatesClient;

const conversations = vi.fn(async (request: ConversationsRequest) => {
  conversationsAsked.push(request);
  return answer([]);
}) as unknown as ConversationsClient;

const onCoreMessage = (listener: (message: CoreMessage) => void) => {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((each) => each !== listener);
  };
};

beforeEach(() => {
  line = {};
  updatesAsked = [];
  conversationsAsked = [];
  opened = [];
  listeners = [];
});

function show(children: React.ReactNode) {
  return render(
    <ShortcutProvider>
      <CommandProvider registry={createCommandRegistry()}>
        <UpdatesProvider client={updates} onOpen={(target) => opened.push(target)}>
          {children}
        </UpdatesProvider>
      </CommandProvider>
    </ShortcutProvider>,
  );
}

describe('the line a Conversation is about', () => {
  it('shows the line as it stands, says what became of it, and links back to its Update', async () => {
    show(<AboutLine about={ABOUT} onCoreMessage={onCoreMessage} />);
    const band = await screen.findByTestId('conversation-about-line');
    expect(band.textContent).toContain('ENG-7 “Ship the report” looks stuck.');
    expect(within(band).getByTestId('conversation-about-line-status').textContent).toBe(
      'Waiting in your Update',
    );

    // Done in the Update: the queue changes, and the Conversation says so.
    line = { status: 'done', settledAt: 5 };
    act(() => {
      for (const listener of listeners)
        listener({ type: 'ares-updates', queued: 0, presence: { state: 'active', since: 1 } });
    });
    await waitFor(() =>
      expect(within(band).getByTestId('conversation-about-line-status').textContent).toBe(
        'You marked it done',
      ),
    );

    fireEvent.click(within(band).getByRole('button', { name: 'Open the Update' }));
    await waitFor(() => expect(screen.getByTestId('update-panel')).toBeTruthy());
    expect(updatesAsked.filter((request) => request.op === 'past').at(-1)).toEqual({ op: 'past', id: 4 });
  });

  it('says so when the line has expired', async () => {
    line = { status: 'expired', settledAt: 5 };
    show(<AboutLine about={ABOUT} onCoreMessage={onCoreMessage} />);
    expect((await screen.findByTestId('conversation-about-line-status')).textContent).toBe(
      'Expired: no longer needed',
    );
  });
});

describe('the line’s actions Ares prepared', () => {
  it('Confirm, with one key, does what the line’s button does, then says so', async () => {
    show(
      <LineActionCards
        turn={answer([card()])}
        about={ABOUT}
        client={conversations}
        onCoreMessage={onCoreMessage}
        focus
      />,
    );
    const shown = await screen.findByTestId('conversation-line-action');
    expect(shown.textContent).toContain('Dismiss the line');
    expect(within(shown).getByTestId('conversation-line-action-status').textContent).toBe('Waiting for you');
    const confirm = within(shown).getByRole('button', { name: /Confirm/ });
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(conversationsAsked).toEqual([
        { op: 'settle-line-action', conversationId: 'c1', turnId: 12, index: 0, status: 'confirmed' },
      ]),
    );
    // Exactly the line's Dismiss.
    expect(updatesAsked).toContainEqual({ op: 'act', queuedId: 9, action: 'dismiss' });
  });

  it('carries out an Item’s own action and a snooze as their buttons do', async () => {
    show(
      <LineActionCards
        turn={answer([
          card({ itemId: 'eng-7', action: 'dismiss', what: 'Take ENG-7 off the line' }),
          card({ action: 'snooze', snooze: 'tomorrow', what: 'Snooze the line until tomorrow at 9:00' }),
          card({ itemId: 'eng-7', action: 'open', what: 'Open ENG-7' }),
        ])}
        about={ABOUT}
        client={conversations}
        onCoreMessage={onCoreMessage}
        focus={false}
      />,
    );
    const cards = await screen.findAllByTestId('conversation-line-action');
    fireEvent.click(within(cards[0] as HTMLElement).getByRole('button', { name: /Confirm/ }));
    await waitFor(() =>
      expect(updatesAsked).toContainEqual({ op: 'act-row', queuedId: 9, itemId: 'eng-7', action: 'dismiss' }),
    );
    fireEvent.click(within(cards[2] as HTMLElement).getByRole('button', { name: /Confirm/ }));
    await waitFor(() => expect(opened).toEqual([{ kind: 'item', sectionId: 'linear', itemId: 'eng-7' }]));
    fireEvent.click(within(cards[1] as HTMLElement).getByRole('button', { name: /Confirm/ }));
    await waitFor(() =>
      expect(updatesAsked).toContainEqual({ op: 'act', queuedId: 9, action: 'snooze', snooze: 'tomorrow' }),
    );
  });

  it('Not now (or Escape) declines it, doing nothing', async () => {
    show(
      <LineActionCards
        turn={answer([card()])}
        about={ABOUT}
        client={conversations}
        onCoreMessage={onCoreMessage}
        focus
      />,
    );
    const shown = await screen.findByTestId('conversation-line-action');
    fireEvent.keyDown(within(shown).getByRole('button', { name: /Confirm/ }), { key: 'Escape' });
    await waitFor(() =>
      expect(conversationsAsked).toEqual([
        { op: 'settle-line-action', conversationId: 'c1', turnId: 12, index: 0, status: 'declined' },
      ]),
    );
    expect(updatesAsked.some((request) => request.op === 'act')).toBe(false);
  });

  it('waits while he is still answering, and offers nothing once the line is dealt with', async () => {
    show(
      <LineActionCards
        turn={answer([card()], 'streaming')}
        about={ABOUT}
        client={conversations}
        onCoreMessage={onCoreMessage}
        focus
      />,
    );
    const shown = await screen.findByTestId('conversation-line-action');
    expect(within(shown).queryByRole('button', { name: /Confirm/ })).toBeNull();
    cleanup();

    line = { status: 'dismissed', settledAt: 5 };
    show(
      <LineActionCards
        turn={answer([card({ action: 'done', what: 'Mark the line done' })])}
        about={ABOUT}
        client={conversations}
        onCoreMessage={onCoreMessage}
        focus
      />,
    );
    const moot = await screen.findByTestId('conversation-line-action');
    expect(moot.getAttribute('data-status')).toBe('moot');
    expect(within(moot).getByTestId('conversation-line-action-status').textContent).toBe(
      'The line: You dismissed it',
    );
    expect(within(moot).queryByRole('button', { name: /Confirm/ })).toBeNull();
  });

  it('a failed action leaves the card waiting, and says why', async () => {
    const failing = vi.fn(async (request: UpdatesRequest) => {
      if (request.op === 'past') return viewWith(line);
      if (request.op === 'act') throw new Error('That line is no longer queued (done)');
      return null;
    }) as unknown as UpdatesClient;
    render(
      <ShortcutProvider>
        <CommandProvider registry={createCommandRegistry()}>
          <UpdatesProvider client={failing} onOpen={() => {}}>
            <LineActionCards
              turn={answer([card()])}
              about={ABOUT}
              client={conversations}
              onCoreMessage={onCoreMessage}
              focus={false}
            />
          </UpdatesProvider>
        </CommandProvider>
      </ShortcutProvider>,
    );
    const shown = await screen.findByTestId('conversation-line-action');
    fireEvent.click(within(shown).getByRole('button', { name: /Confirm/ }));
    await waitFor(() => expect(failing).toHaveBeenCalledWith({ op: 'act', queuedId: 9, action: 'dismiss' }));
    expect(conversationsAsked).toEqual([]);
  });
});
