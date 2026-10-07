// @vitest-environment jsdom
import type { Gate } from '@commander/core/src/autonomy/gate';
import type { ItemStore } from '@commander/core/src/item-store';
import type { Proposal } from '@commander/domain';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AutonomyClient } from './activity';
import { ConversationActions } from './ConversationActions';
import { openTestGate } from './test-gate';

// The cards under one of Ares's answers (#196): what his action Skills did or prepared, read from a real
// gate. A card waiting for the User says exactly what will happen and is confirmed with one key; one
// done says so, with Undo.

let store: ItemStore;
let gate: Gate;
let client: AutonomyClient;
let close: () => void;
let todo: string;
let email: string;
const conversation = { conversationId: 'c1', turnId: 2 };

beforeEach(() => {
  ({ store, gate, client, close } = openTestGate());
  gate.registerAction({ action: 'conversation-todos', actionKind: 'organise', name: 'Manage Todos' });
  gate.registerAction({ action: 'conversation-linear', actionKind: 'act-for-you', name: 'Linear actions' });
  todo = store.record(
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
  email = store.saveFromSource({
    source: 'gmail',
    account: 'me@example.com',
    items: [{ externalId: 'm1', kind: 'email', title: 'Invoice paid' }],
  }).created[0] as string;
});

afterEach(() => {
  cleanup();
  close();
});

const tick = (overrides: Partial<Proposal> = {}): Proposal => ({
  actionKind: 'organise',
  action: 'conversation-todos',
  section: 'todos',
  itemId: todo,
  itemActions: [{ type: 'update', itemId: todo, changes: { status: 'done' } }],
  confidence: 1,
  reason: 'You asked in a Conversation: “Mark the invoice Todo done”',
  conversation,
  ...overrides,
});

function propose(proposal: Proposal): number {
  const outcome = gate.propose(proposal);
  if (outcome.decision === 'off') throw new Error('Off');
  return outcome.decision === 'auto' ? outcome.done.id : outcome.suggestion.id;
}

const status = () => store.get(todo)?.item.status;

describe('cards for what Ares did or prepared in a Conversation', () => {
  it('show one waiting for the User with what will happen and why it asks; Confirm takes the focus, and confirms', async () => {
    const id = propose(tick({ chained: true, causedBy: { itemId: email } }));
    let settled = 0;
    render(
      <ConversationActions proposalIds={[id]} client={client} focusWaiting onSettled={() => settled++} />,
    );
    const card = await screen.findByTestId('conversation-action');
    expect(card.getAttribute('data-status')).toBe('waiting');
    expect(within(card).getByTestId('conversation-action-status').textContent).toBe('Waiting for you');
    expect(card.textContent).toContain('Mark it done');
    expect(card.textContent).toContain('On Pay the invoice');
    expect(within(card).getByTestId('conversation-action-cause').textContent).toBe(
      'Suggested because of Invoice paid',
    );
    const confirm = within(card).getByRole('button', { name: /Confirm/ });
    // One key: Confirm has the focus, so Enter presses it.
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    await act(async () => fireEvent.click(confirm));
    await waitFor(() => expect(card.getAttribute('data-status')).toBe('confirmed'));
    expect(status()).toBe('done');
    expect(settled).toBe(1);
  });

  it('dismiss a waiting card with Escape, and never take the focus while the User is writing', async () => {
    const id = propose(tick({ actionKind: 'act-for-you', action: 'conversation-linear', section: 'linear' }));
    render(<ConversationActions proposalIds={[id]} client={client} />);
    const card = await screen.findByTestId('conversation-action');
    expect(card.textContent).toContain('Asks first: other people will see it.');
    expect(document.activeElement).not.toBe(within(card).getByRole('button', { name: /Confirm/ }));
    await act(async () => fireEvent.keyDown(card, { key: 'Escape' }));
    await waitFor(() => expect(card.getAttribute('data-status')).toBe('dismissed'));
    expect(status()).toBe('open');
  });

  it('show what Ares did with Undo, and that it was undone', async () => {
    const id = propose(tick());
    expect(status()).toBe('done');
    render(<ConversationActions proposalIds={[id]} client={client} />);
    const card = await screen.findByTestId('conversation-action');
    expect(card.getAttribute('data-status')).toBe('done');
    expect(within(card).getByTestId('conversation-action-status').textContent).toBe('Done by Ares');
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: 'Undo' })));
    await waitFor(() => expect(card.getAttribute('data-status')).toBe('undone'));
    expect(status()).toBe('open');
  });

  it('read the cards again when Ares’s activity changes elsewhere', async () => {
    const id = propose(tick({ chained: true, causedBy: { itemId: email } }));
    const listeners = new Set<() => void>();
    render(
      <ConversationActions
        proposalIds={[id]}
        client={client}
        onAresActivity={(listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }}
      />,
    );
    const card = await screen.findByTestId('conversation-action');
    gate.accept(id);
    act(() => {
      for (const listener of listeners) listener();
    });
    await waitFor(() => expect(card.getAttribute('data-status')).toBe('confirmed'));
  });
});
