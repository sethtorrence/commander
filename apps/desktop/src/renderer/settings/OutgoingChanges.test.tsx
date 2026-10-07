// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { LinearIssueDetail } from '@commander/domain';
import type { LinearAccountSummary } from '@commander/domain/ipc';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openTestItemStore } from '../item-store/test-item-store';
import { FrameControlsProvider } from '../sections/section';
import { OutgoingChanges } from './OutgoingChanges';
import { describeOutgoing, outgoingChangesIn } from './outgoing-changes';

// An Account's changes that didn't reach its Source, in Settings → Accounts (#206), against a real
// Item store: the counts beside its sync status, and the list with Retry and Discard.

const ACME = 'linear:org-acme';
const NOW = new Date(2026, 9, 3, 15, 0).getTime();
const progress = { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' };
const review = { id: 'state-review', name: 'In Review', type: 'started', color: '#5e6ad2' };

let store: ItemStore;
let client: ReturnType<typeof outgoingChangesIn>;
let close: () => void;
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };

const detail: LinearIssueDetail = {
  kind: 'linear-issue',
  identifier: 'ENG-418',
  url: 'https://linear.app/acme/issue/ENG-418',
  team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
  state: progress,
  priority: 2,
  assignee: null,
  creator: null,
  labels: [],
  cycle: null,
  linearProject: null,
  dueDate: null,
  estimate: null,
  description: null,
  comments: [],
  createdAt: 1,
  updatedAt: 1,
  startedAt: null,
  completedAt: null,
  canceledAt: null,
};

const account = (pending: number, failed: number): LinearAccountSummary => ({
  id: ACME,
  source: 'linear',
  name: 'Acme',
  urlKey: 'acme',
  method: 'oauth',
  status: 'connected',
  user: null,
  sync: {
    account: ACME,
    source: 'linear',
    activity: 'idle',
    cadenceMinutes: 15,
    cadenceChoices: [15, 30, 60],
    lastSyncedAt: NOW,
    nextSyncAt: null,
    itemCount: 1,
    problem: null,
    outgoing: { pending, failed },
  },
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const opened = openTestItemStore(() => NOW);
  ({ store, close } = opened);
  client = outgoingChangesIn(opened.client);
  store.saveFromSource({
    source: 'linear',
    account: ACME,
    items: [{ externalId: 'issue-418', kind: 'linear-issue', title: 'Fix the login loop', detail }],
  });
  const [issue] = store.query({ kinds: ['linear-issue'] });
  store.record(
    { type: 'edit-fields', itemId: issue?.id as string, fields: { state: review } },
    { by: { kind: 'user' } },
  );
  store.outgoing.fail(
    store.outgoing.rows().map((row) => row.id),
    { error: 'The issue is locked for editing.', failed: true, nextAttemptAt: null },
  );
});

afterEach(() => {
  cleanup();
  close();
  vi.useRealTimers();
});

const show = (summary = account(0, 1)) =>
  render(
    <FrameControlsProvider value={controls}>
      <OutgoingChanges account={summary} client={client} />
    </FrameControlsProvider>,
  );
const stateOf = () =>
  (store.query({ kinds: ['linear-issue'] })[0]?.detail as LinearIssueDetail | undefined)?.state;

describe('the counts', () => {
  it('say how many changes are waiting and how many couldn’t sync', () => {
    expect(describeOutgoing({ pending: 2, failed: 1 })).toBe('2 changes waiting · 1 couldn’t sync');
    expect(describeOutgoing({ pending: 0, failed: 1 })).toBe('1 change couldn’t sync');
    expect(describeOutgoing({ pending: 1, failed: 0 })).toBe('1 change waiting');
    expect(describeOutgoing({ pending: 0, failed: 0 })).toBeNull();
  });

  it('show beside the Account’s sync, and nothing does when nothing is queued', () => {
    const { unmount } = show(account(0, 0));
    expect(screen.queryByTestId('account-outgoing')).toBeNull();
    unmount();
    show(account(2, 1));
    expect(screen.getByTestId('account-outgoing-counts').textContent).toBe(
      '2 changes waiting · 1 couldn’t sync',
    );
  });
});

describe('the list', () => {
  it('names each change, its Item, when it was made and why it stopped', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Show changes' }));
    const [change] = await screen.findAllByTestId('outgoing-change');
    expect(change?.textContent).toContain('Move to In Review');
    expect(change?.textContent).toContain('ENG-418');
    expect(change?.textContent).toContain('Fix the login loop');
    expect(within(change as HTMLElement).getByTestId('outgoing-change-state').textContent).toBe(
      'Couldn’t sync · Made 15:00 · The issue is locked for editing.',
    );
  });

  it('retries a change that couldn’t sync', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Show changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry: Move to In Review' }));
    await waitFor(() => expect(store.outgoing.rows()[0]?.status).toBe('pending'));
  });

  it('discards after a confirmation, putting the issue back as Linear has it', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Show changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard: Move to In Review' }));
    const dialog = await screen.findByTestId('discard-change-dialog');
    expect(dialog.textContent).toContain('ENG-418 goes back to what the Source has');
    expect(stateOf()).toEqual(review);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(store.outgoing.rows()).toEqual([]));
    expect(stateOf()).toEqual(progress);
  });
});
