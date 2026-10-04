import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, Proposal } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { type Gate, openGate } from './gate';

// Proposals that make an event at a Source (#131): a focus block for a Todo (Tidy your Sources, as it
// goes in the User's own calendar, seen by no one), carried out through the Item store's create-event
// path, so accepting queues it for the Source and undoing deletes it there.

const user: ActionContext = { by: { kind: 'user' } };
const ACCOUNT = 'google:104512345678901234567';
const START = Date.UTC(2026, 9, 8, 8);
const HOUR = 60 * 60_000;

let dir: string;
let store: ItemStore;
let gate: Gate;
let todo: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-gate-events-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => Date.UTC(2026, 9, 5, 7),
  });
  store.calendars.listed(ACCOUNT, 'google-calendar', [
    { id: 'alex@gmail.test', name: 'alex@gmail.test', colour: '#9fe1e7', primary: true, accessRole: 'owner' },
  ]);
  gate = openGate({ itemStore: store });
  gate.registerAction({ action: 'focus-blocks', actionKind: 'tidy-sources', name: 'Block time for Todos' });
  gate.registerAction({ action: 'suggest-todos', actionKind: 'organise', name: 'Suggest Todos' });
  todo = store.record(
    {
      type: 'create',
      item: {
        kind: 'todo',
        title: 'Fix the login bug',
        detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null },
      },
    },
    user,
  ).itemId;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const time = (at: number) => ({ at, timeZone: 'Europe/London', date: null });

function focusBlock(overrides: Partial<Proposal> = {}): Proposal {
  return {
    actionKind: 'tidy-sources',
    action: 'focus-blocks',
    section: 'calendar',
    itemId: todo,
    itemActions: [
      {
        type: 'create-event',
        event: {
          kind: 'focus-block',
          account: ACCOUNT,
          title: 'Focus: Fix the login bug',
          start: time(START),
          end: time(START + 2 * HOUR),
        },
      },
      { type: 'link', from: { step: 0 }, linkType: 'made-from', to: todo },
    ],
    confidence: 0.7,
    reason: 'You’re free Thursday 9–11.',
    ...overrides,
  };
}

describe('a proposal that makes an event', () => {
  it('waits as a suggestion at Ask, and accepting makes the event, Linked to its Todo, queued for the Source', () => {
    const outcome = gate.propose(focusBlock());
    if (outcome.decision !== 'ask') throw new Error(`Wanted a suggestion, got ${outcome.decision}`);
    expect(store.query({ kinds: ['event'] })).toEqual([]);

    const accepted = gate.accept(outcome.suggestion.id);
    const [eventEntry] = accepted.entryIds;
    const event = store.get(store.entry(eventEntry as number)?.itemId as string);
    expect(event?.item).toMatchObject({ kind: 'event', title: 'Focus: Fix the login bug' });
    expect(event?.item.detail).toMatchObject({
      busy: true,
      private: true,
      createdByCommander: 'focus-block',
    });
    expect(event?.links).toMatchObject([{ type: 'made-from', to: { id: todo } }]);
    expect(store.get(todo)?.backlinks).toMatchObject([{ type: 'made-from', from: { id: event?.item.id } }]);
    expect(store.outgoing.forItem(event?.item.id as string).map((row) => row.field)).toEqual(['create']);
  });

  it('accepts all at once, as Tidy your Sources allows', () => {
    const first = gate.propose(focusBlock());
    const second = gate.propose(
      focusBlock({
        itemActions: [
          {
            type: 'create-event',
            event: {
              kind: 'focus-block',
              account: ACCOUNT,
              title: 'Focus: Fix the login bug',
              start: time(START + 4 * HOUR),
              end: time(START + 5 * HOUR),
            },
          },
        ],
      }),
    );
    if (first.decision !== 'ask' || second.decision !== 'ask') throw new Error('Wanted suggestions');
    gate.acceptAll([first.suggestion.id, second.suggestion.id]);
    expect(store.query({ kinds: ['event'] })).toHaveLength(2);
  });

  it('undoing takes the event away and queues its deletion: no Delete gate for an event Commander just made', () => {
    const outcome = gate.propose(focusBlock());
    if (outcome.decision !== 'ask') throw new Error('Wanted a suggestion');
    const accepted = gate.accept(outcome.suggestion.id);
    const eventId = store.entry(accepted.entryIds[0] as number)?.itemId as string;
    gate.undo(accepted.id);
    expect(store.get(eventId)?.item.deletedAt).not.toBeNull();
    expect(store.get(todo)?.backlinks).toEqual([]);
    expect(store.outgoing.forItem(eventId).map((row) => [row.field, row.value])).toEqual([
      ['create', expect.anything()],
      ['delete', true],
    ]);
  });

  it('is carried out at once when the action is set to Auto', () => {
    gate.setLevel({ scope: 'action', action: 'focus-blocks' }, 'auto');
    const outcome = gate.propose(focusBlock());
    expect(outcome.decision).toBe('auto');
    expect(store.query({ kinds: ['event'] })).toHaveLength(1);
  });

  it('can’t be Organise, which stays inside Commander', () => {
    expect(() =>
      gate.propose(focusBlock({ actionKind: 'organise', action: 'suggest-todos', section: 'notes' })),
    ).toThrow(/Tidy your Sources/);
  });
});
