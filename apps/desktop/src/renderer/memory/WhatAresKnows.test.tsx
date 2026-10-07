// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { ActionContext, LinearIssueDetail, Project } from '@commander/domain';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onReveal, requestReveal } from '../frame/reveal';
import type { ItemStoreClient } from '../item-store/client';
import { openTestItemStore } from '../item-store/test-item-store';
import { CONVERSATIONS_REVEAL } from '../sections/ares/conversations';
import { WHAT_ARES_KNOWS, WhatAresKnows } from './WhatAresKnows';

// What Ares knows (#74): every memory, grouped by kind, each with where it came from and when; the
// User searches, confirms, edits and deletes them, adds a preference, and keeps or deletes a fact
// whose source was deleted, which waits at the top for review. A real Item store behind the window's
// channel.

const user: ActionContext = { by: { kind: 'user' } };

let store: ItemStore;
let client: ItemStoreClient;
let close: () => void;
let tl: Project;

function issue(title: string): string {
  const detail: LinearIssueDetail = {
    kind: 'linear-issue',
    identifier: 'OPS-1',
    url: 'https://linear.app/acme/issue/OPS-1',
    team: { id: 'team-ops', key: 'OPS', name: 'Operations' },
    state: { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
    priority: 0,
    assignee: null,
    creator: null,
    labels: [],
    cycle: null,
    linearProject: null,
    dueDate: null,
    estimate: null,
    description: null,
    comments: [],
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
  };
  return store.saveFromSource({
    source: 'linear',
    account: 'linear:org-acme',
    items: [{ externalId: 'i1', kind: 'linear-issue', title, detail }],
  }).created[0] as string;
}

const memoryRow = (text: string | RegExp) =>
  screen.getAllByTestId('memory').find((row) => row.textContent?.match(text)) as HTMLElement;

beforeEach(() => {
  // 09:30 local, so a memory learned now reads "4 Oct" in every time zone.
  ({ store, client, close } = openTestItemStore(() => new Date(2026, 9, 4, 9, 30).getTime()));
  tl = store.changeProject({ type: 'create', project: { name: 'Titanlink', code: 'TL', accent: 'blue' } })
    .project as Project;
});

afterEach(() => {
  cleanup();
  close();
});

describe('What Ares knows', () => {
  it('lists memories by kind, each with its sources and date, and lets the User confirm an unconfirmed fact', async () => {
    const relay = issue('Relay retries');
    store.memory.learn({
      kind: 'fact',
      text: 'Priya works mostly on TL',
      confirmed: false,
      sources: [relay],
    });
    store.memory.learn({
      kind: 'example',
      text: 'OPS-1 belongs to TX, not TL',
      confirmed: true,
      sources: [relay],
    });
    store.memory.change({ type: 'add-preference', text: 'Keep Todo titles short' });
    store.changeRule({
      type: 'create',
      rule: {
        target: { kind: 'project', projectId: tl.id },
        when: { join: 'and', terms: [{ field: 'linear.team', op: 'is', value: 'team-ops', label: 'OPS' }] },
      },
    });
    render(<WhatAresKnows client={client} shown />);

    const facts = await screen.findByRole('list', { name: 'Facts' });
    expect(within(facts).getByText('Priya works mostly on TL')).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Examples' })).getByText('OPS-1 belongs to TX, not TL'),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Preferences' })).getByText('Keep Todo titles short'),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Rules' })).getByText('team is OPS → TL · Titanlink'),
    ).toBeTruthy();

    const fact = memoryRow('Priya works mostly on TL');
    expect(within(fact).getByText('Unconfirmed')).toBeTruthy();
    expect(within(fact).getByRole('button', { name: 'Relay retries' })).toBeTruthy();
    expect(fact.textContent).toContain('4 Oct');
    // A Rule is changed only in the Rules list.
    const rule = memoryRow('team is OPS');
    expect(within(rule).queryByRole('button', { name: /Edit|Delete/ })).toBeNull();
    expect(rule.textContent).toContain('Settings → Rules');

    fireEvent.click(within(fact).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(within(memoryRow('Priya works mostly on TL')).queryByText('Unconfirmed')).toBeNull(),
    );
    expect(store.memory.list().memories.find((memory) => memory.kind === 'fact')?.confirmed).toBe(true);
  });

  it('searches as the User types, edits a memory’s words and deletes one', async () => {
    store.memory.learn({
      kind: 'fact',
      text: 'Longtail’s beta launches in November',
      confirmed: true,
      sources: [],
    });
    store.memory.learn({
      kind: 'fact',
      text: 'Dana leads the reliability push',
      confirmed: true,
      sources: [],
    });
    render(<WhatAresKnows client={client} shown />);
    await screen.findByText('Dana leads the reliability push');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search what Ares knows' }), {
      target: { value: 'beta nov' },
    });
    await waitFor(() => expect(screen.queryByText('Dana leads the reliability push')).toBeNull());
    expect(screen.getByText('Longtail’s beta launches in November')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search what Ares knows' }), {
      target: { value: '' },
    });
    await screen.findByText('Dana leads the reliability push');

    fireEvent.click(within(memoryRow('Dana leads')).getByRole('button', { name: 'Edit' }));
    const words = screen.getByRole('textbox', { name: 'Words for this memory' });
    fireEvent.change(words, { target: { value: 'Dana leads reliability and on-call' } });
    fireEvent.submit(words);
    await screen.findByText('Dana leads reliability and on-call');

    fireEvent.click(within(memoryRow('Longtail')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('Longtail’s beta launches in November')).toBeNull());
    expect(store.memory.list().memories.map((memory) => memory.text)).toEqual([
      'Dana leads reliability and on-call',
    ]);
  });

  it('adds a preference by hand', async () => {
    render(<WhatAresKnows client={client} shown />);
    const field = await screen.findByRole('textbox', { name: 'A preference for Ares' });
    fireEvent.change(field, { target: { value: 'Never suggest Todos for errands' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add preference' }));
    const preferences = await screen.findByRole('list', { name: 'Preferences' });
    expect(within(preferences).getByText('Never suggest Todos for errands')).toBeTruthy();
  });

  it('puts a fact whose source was deleted at the top for review, until the User keeps it', async () => {
    const relay = issue('Relay retries');
    store.memory.learn({
      kind: 'fact',
      text: 'Relay launches in November',
      confirmed: true,
      sources: [relay],
    });
    store.record({ type: 'delete', itemId: relay }, user);
    render(<WhatAresKnows client={client} shown />);

    const review = await screen.findByRole('list', { name: 'For review' });
    expect(within(review).getByText('Relay launches in November')).toBeTruthy();
    expect(review.textContent).toContain('deleted');
    fireEvent.click(within(review).getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'For review' })).toBeNull());
    expect(
      within(screen.getByRole('list', { name: 'Facts' })).getByText('Relay launches in November'),
    ).toBeTruthy();
  });

  it('shows the memory it is asked to (from the palette)', async () => {
    const memory = store.memory.learn({ kind: 'fact', text: 'Dana leads TX', confirmed: true, sources: [] });
    render(<WhatAresKnows client={client} shown />);
    await screen.findByText('Dana leads TX');
    act(() => requestReveal(WHAT_ARES_KNOWS, memory?.id ?? ''));
    await waitFor(() => expect(memoryRow('Dana leads TX').getAttribute('aria-current')).toBe('true'));
  });
});

describe('What the User told Ares in a Conversation (#194)', () => {
  it('links to the turn it came from, opening the Conversation there, and reads “a deleted Conversation” once it is gone', async () => {
    const { conversation } = store.conversations.create('2026-10-04');
    const turn = store.conversations.addUserTurn(conversation.id, 'I don’t take meetings before 10');
    store.memory.tell(
      {
        kind: 'preference',
        key: 'preference:no meetings before 10',
        text: 'The User doesn’t take meetings before 10',
        confirmed: true,
        sources: [],
      },
      { conversationId: conversation.id, turnId: turn.id },
    );
    const revealed: [string, string | undefined][] = [];
    const stop = onReveal(CONVERSATIONS_REVEAL, (conversationId, focus) =>
      revealed.push([conversationId, focus]),
    );
    render(<WhatAresKnows client={client} shown />);
    const row = await waitFor(() => memoryRow('The User doesn’t take meetings before 10'));
    expect(row.textContent).toMatch(/Added 4 Oct/);
    fireEvent.click(within(row).getByRole('button', { name: 'I don’t take meetings before 10' }));
    expect(revealed).toEqual([[conversation.id, String(turn.id)]]);
    stop();
    cleanup();

    store.conversations.remove(conversation.id);
    render(<WhatAresKnows client={client} shown />);
    const kept = await waitFor(() => memoryRow('The User doesn’t take meetings before 10'));
    expect(within(kept).getByText('a deleted Conversation')).toBeTruthy();
  });
});
