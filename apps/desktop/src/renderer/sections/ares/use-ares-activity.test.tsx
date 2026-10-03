// @vitest-environment jsdom
import type { Gate } from '@commander/core/src/autonomy/gate';
import type { ItemStore } from '@commander/core/src/item-store';
import type { Proposal } from '@commander/domain';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AresActivityFilters, bulkAcceptable, describeActivity } from './activity';
import { openTestGate } from './test-gate';
import { useAresActivity } from './use-ares-activity';

let store: ItemStore;
let gate: Gate;
let client: Parameters<typeof useAresActivity>[0];
let close: () => void;
let email: string;
let block: string;

beforeEach(() => {
  const opened = openTestGate();
  ({ store, gate, client, close } = opened);
  gate.registerAction({ action: 'suggest-todos', actionKind: 'organise', name: 'Suggest Todos' });
  gate.registerAction({ action: 'archive-email', actionKind: 'tidy-sources', name: 'Archive email' });
  gate.registerAction({ action: 'reply', actionKind: 'act-for-you', name: 'Send replies' });
  email = store.saveFromSource({
    source: 'gmail',
    account: 'me@example.com',
    items: [{ externalId: 'm1', kind: 'email', title: 'Dana: Q3 numbers?' }],
  }).created[0] as string;
  block = store.record(
    {
      type: 'create',
      item: {
        kind: 'block',
        title: 'send Dana the numbers',
        detail: {
          kind: 'block',
          dailyNoteId: store.ensureDailyNote('2026-10-01', { by: { kind: 'user' } }).id,
          parentId: null,
          position: 'a0',
          text: 'send Dana the numbers',
          folded: false,
        },
      },
    },
    { by: { kind: 'user' } },
  ).itemId;
});

afterEach(() => {
  cleanup();
  close();
});

const todoFromBlock = (confidence: number): Proposal => ({
  actionKind: 'organise',
  action: 'suggest-todos',
  section: 'notes',
  itemId: block,
  itemActions: [{ type: 'create', item: { kind: 'todo', title: 'Send Dana the numbers' } }],
  confidence,
  reason: 'You wrote you need to send Dana the numbers',
});
const archive = (): Proposal => ({
  actionKind: 'tidy-sources',
  action: 'archive-email',
  section: 'email',
  itemId: email,
  itemActions: [{ type: 'update', itemId: email, changes: { status: 'archived' } }],
  confidence: 1,
  reason: 'Answered already',
});
const reply = (): Proposal => ({
  actionKind: 'act-for-you',
  action: 'reply',
  section: 'email',
  itemId: email,
  itemActions: [{ type: 'update', itemId: email, changes: { status: 'done' } }],
  confidence: 1,
  reason: 'Dana asked for the numbers',
  causedBy: { itemId: email },
});

async function render(filters: AresActivityFilters = {}) {
  const hook = renderHook((props: AresActivityFilters) => useAresActivity(client, props, true), {
    initialProps: filters,
  });
  await waitFor(() => expect(hook.result.current.rows).not.toBeNull());
  return hook;
}

const lines = (rows: Parameters<typeof describeActivity>[0][] | null) =>
  rows?.map((row) => describeActivity(row));

describe('useAresActivity', () => {
  it('lists what Ares did and suggested, newest first', async () => {
    gate.propose(todoFromBlock(0.9));
    gate.propose(archive());
    const { result } = await render();
    expect(lines(result.current.rows)).toEqual(['Waiting for you', 'Done by Ares']);
  });

  it('filters by Action kind and Section', async () => {
    gate.propose(todoFromBlock(0.9));
    gate.propose(archive());
    const hook = await render({ actionKind: 'organise' });
    expect(hook.result.current.rows?.map((row) => row.name)).toEqual(['Suggest Todos']);
    hook.rerender({ section: 'email' });
    await waitFor(() => expect(hook.result.current.rows?.map((row) => row.name)).toEqual(['Archive email']));
  });

  it('accepts and dismisses a suggestion', async () => {
    gate.propose(archive());
    gate.propose(todoFromBlock(0.5));
    const { result } = await render();
    const [todo, archiving] = result.current.rows ?? [];
    await act(() => result.current.accept(archiving?.id as number));
    await act(() => result.current.dismiss(todo?.id as number));
    await waitFor(() => expect(lines(result.current.rows)).toEqual(['Dismissed', 'Accepted by you']));
    expect(store.get(email)?.item.status).toBe('archived');
  });

  it('accepts every waiting Organise or Tidy your Sources suggestion of one kind at once', async () => {
    gate.propose(todoFromBlock(0.5));
    gate.propose(todoFromBlock(0.4));
    gate.propose(archive());
    const { result } = await render();
    await act(() => result.current.acceptAll('organise'));
    await waitFor(() =>
      expect(result.current.rows?.map((row) => `${row.name}: ${describeActivity(row)}`)).toEqual([
        'Archive email: Waiting for you',
        'Suggest Todos: Accepted by you',
        'Suggest Todos: Accepted by you',
      ]),
    );
  });

  it('never offers to accept Act for you or Delete suggestions all at once', () => {
    expect(bulkAcceptable('organise')).toBe(true);
    expect(bulkAcceptable('tidy-sources')).toBe(true);
    expect(bulkAcceptable('act-for-you')).toBe(false);
    expect(bulkAcceptable('delete')).toBe(false);
  });

  it('undoes an automatic action', async () => {
    gate.propose(todoFromBlock(0.9));
    const { result } = await render();
    await act(() => result.current.undo(result.current.rows?.[0]?.id as number));
    await waitFor(() => expect(lines(result.current.rows)).toEqual(['Done by Ares · undone']));
    expect(store.query({ kinds: ['todo'] })).toEqual([]);
  });

  it('says what caused a suggestion', async () => {
    gate.propose(reply());
    const { result } = await render();
    expect(result.current.rows?.[0]?.cause?.item?.title).toBe('Dana: Q3 numbers?');
  });
});
