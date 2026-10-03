// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import { localDay } from '@commander/domain';
import type { AccountSummary } from '@commander/domain/ipc';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onReveal } from '../../frame/reveal';
import { openTestItemStore } from '../../item-store/test-item-store';
import { ProjectsProvider } from '../../projects/context';
import { type ProjectsClient, projectsIn } from '../../projects/projects';
import { ShortcutProvider, ShortcutScope, useActiveScopes } from '../../shortcuts/react';
import type { LinearAccountsClient } from '../linear/linear-issues';
import { ACME, CURRENT_CYCLE, issue, NOW, PRIYA, SAM, STATES } from '../linear/test-issues';
import { addDays } from '../notes/days';
import { FrameControlsProvider, SectionProvider } from '../section';
import { dashboard as definition } from '.';
import { DashboardProvider } from './context';
import { DashboardSheet } from './DashboardSheet';
import { CLEARS_STORAGE_KEY, type DashboardClient, dashboardIn } from './dashboard';

// The Dashboard Section over a real Item store: Todos added as the User, Linear issues as Linear sync
// saves them, and a stand-in for the Linear Accounts. The clock is fixed: Saturday 3 October 2026.

const TODAY = localDay(NOW);
const YESTERDAY = addDays(TODAY, -1);

let store: ItemStore;
let projects: ProjectsClient;
let client: DashboardClient;
let accounts: ReturnType<typeof fakeAccounts>;
let close: () => void;
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };

function fakeAccounts(initial: AccountSummary[]) {
  let current = initial;
  const listeners = new Set<(accounts: AccountSummary[]) => void>();
  const client: LinearAccountsClient = {
    list: async () => current,
    syncNow: async () => {},
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    client,
    change(next: AccountSummary[]) {
      current = next;
      act(() => {
        for (const listener of listeners) listener(next);
      });
    },
  };
}

const acme = (lastSyncedAt = NOW - 60_000): AccountSummary => ({
  id: ACME,
  source: 'linear',
  name: 'Acme',
  urlKey: 'acme',
  method: 'api-key',
  status: 'connected',
  user: { id: SAM.id, name: SAM.name },
  sync: {
    account: ACME,
    source: 'linear',
    activity: 'idle',
    cadenceMinutes: 15,
    cadenceChoices: [15, 30, 60],
    lastSyncedAt,
    nextSyncAt: null,
    itemCount: 3,
    problem: null,
    outgoing: { pending: 0, failed: 0 },
  },
});

function addTodo(title: string, dueOn: string | null, projectId?: string) {
  return store.record(
    {
      type: 'create',
      item: {
        kind: 'todo',
        title,
        filing: projectId ? { projectId, filedBy: 'user' } : null,
        detail: { kind: 'todo', origin: 'manual', dueOn, backedBy: null },
      },
    },
    { by: { kind: 'user' } },
  ).itemId;
}

const saveIssues = (...items: ReturnType<typeof issue>[]) =>
  store.saveFromSource({ source: 'linear', account: ACME, items });

beforeEach(() => {
  const opened = openTestItemStore();
  ({ store, close } = opened);
  projects = projectsIn(opened.client);
  accounts = fakeAccounts([acme()]);
  client = dashboardIn(opened.client, accounts.client);
  localStorage.clear();
  for (const mock of Object.values(controls)) mock.mockReset();
  Element.prototype.scrollIntoView = () => {};

  addTodo('Send the invoice', YESTERDAY);
  addTodo('Book the dentist', TODAY);
  addTodo('Someday: learn the cello', null);
  saveIssues(
    issue({
      identifier: 'ENG-1',
      title: 'Fix the outage',
      assignee: SAM,
      priority: 1,
      updatedAt: NOW - 60_000,
    }),
    issue({ identifier: 'ENG-2', title: 'Write the runbook', assignee: SAM, state: STATES.progress }),
    issue({
      identifier: 'ENG-3',
      title: 'Rate limiter',
      assignee: SAM,
      state: STATES.review,
      cycle: CURRENT_CYCLE,
    }),
    issue({
      identifier: 'ENG-4',
      title: 'Audit log export',
      creator: SAM,
      assignee: PRIYA,
      updatedAt: NOW - 2 * 3_600_000,
    }),
    issue({ identifier: 'ENG-5', title: 'Backlog thing', assignee: SAM, state: STATES.backlog }),
  );
});

afterEach(() => {
  cleanup();
  close();
});

function Active({ children }: { children: ReactNode }) {
  useActiveScopes(['dashboard']);
  return children;
}

const place = { definition, number: 1, total: 8, active: true };

function renderSheet() {
  return render(
    <ShortcutProvider>
      <ProjectsProvider client={projects} storage={localStorage}>
        <DashboardProvider client={client} storage={localStorage} clock={() => NOW}>
          <FrameControlsProvider value={controls}>
            <SectionProvider place={place}>
              <ShortcutScope scope="dashboard" group="Dashboard">
                <Active>
                  <DashboardSheet />
                </Active>
              </ShortcutScope>
            </SectionProvider>
          </FrameControlsProvider>
        </DashboardProvider>
      </ProjectsProvider>
    </ShortcutProvider>,
  );
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(document.body, { key, ...init });
  });

const band = (name: string) => screen.getByRole('region', { name });
const titles = (name: string) =>
  within(band(name))
    .queryAllByTestId('dashboard-row')
    .map((row) => row.getAttribute('aria-label'));
const selected = () =>
  screen
    .getAllByTestId('dashboard-row')
    .find((row) => row.getAttribute('aria-current'))
    ?.getAttribute('aria-label');

async function loaded() {
  await waitFor(() => expect(titles('Now')).toHaveLength(2));
}

describe('the Dashboard', () => {
  it('ranks Todos and Linear issues into the four bands, with reasons, Source stamps and counts', async () => {
    renderSheet();
    await loaded();
    expect(titles('Now')).toEqual(['ENG-1 Fix the outage', 'Send the invoice']);
    expect(titles('Today')).toEqual(['Book the dentist', 'ENG-2 Write the runbook']);
    expect(titles('Waiting on others')).toEqual(['ENG-3 Rate limiter']);
    expect(titles('FYI')).toEqual(['ENG-4 Audit log export']);

    const first = within(band('Now')).getAllByTestId('dashboard-row')[0] as HTMLElement;
    expect(within(first).getByTestId('source-stamp').textContent).toBe('LINTodo');
    expect(within(first).getByTestId('row-reason').textContent).toBe('Urgent · ENG');
    const invoice = within(band('Now')).getAllByTestId('dashboard-row')[1] as HTMLElement;
    expect(within(invoice).getByTestId('source-stamp').textContent).toMatch(/^TODOManual · due/);
    expect(within(invoice).getByTestId('row-reason').textContent).toBe('Overdue since yesterday');
    expect(within(band('Now')).getByTestId('band-count').textContent).toBe('02 open');
    expect(within(band('FYI')).getByTestId('band-count').textContent).toBe('01 to know');

    // The tab counts Now and Today.
    await waitFor(() => expect(controls.setTabCount).toHaveBeenLastCalledWith('dashboard', 4));
  });

  it('moves with j and k, and opens the selected Item in its Section with Enter', async () => {
    renderSheet();
    await loaded();
    expect(selected()).toBe('ENG-1 Fix the outage');
    await press('j');
    expect(selected()).toBe('Send the invoice');
    // The Sections hear which Item to show (frame/reveal.ts).
    const shown: string[] = [];
    const stops = ['todos', 'linear'].map((id) => onReveal(id, (itemId) => shown.push(`${id} ${itemId}`)));
    await press('Enter');
    const invoice = store.query({ titleContains: 'invoice' })[0];
    expect(controls.openSection).toHaveBeenLastCalledWith('todos');
    await press('k');
    await press('Enter');
    const outage = store.query({ titleContains: 'outage' })[0];
    expect(controls.openSection).toHaveBeenLastCalledWith('linear');
    expect(shown).toEqual([`todos ${invoice?.id}`, `linear ${outage?.id}`]);
    for (const stop of stops) stop();
  });

  it('ticks a Todo with x: it stays, struck through, and is ticked in the Item store; undo unticks it', async () => {
    renderSheet();
    await loaded();
    await press('j');
    await press('x');
    await waitFor(() => expect(store.query({ titleContains: 'invoice' })[0]?.status).toBe('done'));
    await waitFor(() =>
      expect(within(band('Now')).getByTestId('band-count').textContent).toBe('01 open · 01 done'),
    );
    expect(titles('Now')).toEqual(['ENG-1 Fix the outage', 'Send the invoice']);

    await press('z', { ctrlKey: true });
    await waitFor(() => expect(store.query({ titleContains: 'invoice' })[0]?.status).toBe('open'));
    await waitFor(() => expect(within(band('Now')).getByTestId('band-count').textContent).toBe('02 open'));
  });

  it('doesn’t tick a Linear issue: that comes with Linear-backed Todos', async () => {
    renderSheet();
    await loaded();
    await press('x');
    expect(store.query({ titleContains: 'outage' })[0]?.status).toBe('open');
  });

  it('clears a row with e: it leaves the Dashboard, stays in its Section, and comes back when its band changes', async () => {
    const view = renderSheet();
    await loaded();
    await press('j');
    await press('e');
    await waitFor(() => expect(titles('Now')).toEqual(['ENG-1 Fix the outage']));
    expect(store.query({ titleContains: 'invoice' })[0]?.status).toBe('open');
    expect(screen.getByText(/1 cleared/)).toBeTruthy();
    // The selection moves on to the next row.
    expect(selected()).toBe('Book the dentist');

    // Remembered: a restart keeps it cleared.
    view.unmount();
    renderSheet();
    await waitFor(() => expect(titles('Today')).toHaveLength(2));
    expect(titles('Now')).toEqual(['ENG-1 Fix the outage']);

    // Its band changes (now due today, so Today), and it is back.
    const invoice = store.query({ titleContains: 'invoice' })[0];
    store.record(
      {
        type: 'update',
        itemId: invoice?.id ?? '',
        changes: { detail: { kind: 'todo', origin: 'manual', dueOn: TODAY, backedBy: null } },
      },
      { by: { kind: 'user' } },
    );
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(titles('Today')).toContain('Send the invoice'));
    expect(JSON.parse(localStorage.getItem(CLEARS_STORAGE_KEY) ?? '{}')).toEqual({});
  });

  it('undoes a clear, and brings cleared rows back', async () => {
    renderSheet();
    await loaded();
    await press('e');
    await waitFor(() => expect(titles('Now')).toEqual(['Send the invoice']));
    await press('z', { ctrlKey: true });
    await waitFor(() => expect(titles('Now')).toHaveLength(2));

    await press('e');
    await waitFor(() => expect(titles('Now')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Bring them back' }));
    await waitFor(() => expect(titles('Now')).toHaveLength(2));
  });

  it('narrows to the Project filter, with counts per Project', async () => {
    const longtail = await projects.create({ name: 'Longtail', code: 'LT', accent: 'blue' });
    addTodo('Ship the Longtail beta', YESTERDAY, longtail.id);
    renderSheet();
    await waitFor(() => expect(titles('Now')).toHaveLength(3));
    const bar = screen.getByRole('group', { name: 'Project filter' });
    expect(within(bar).getByRole('button', { name: /Everything/ }).textContent).toMatch(/07/);
    expect(within(bar).getByRole('button', { name: /Longtail/ }).textContent).toMatch(/01/);

    fireEvent.click(within(bar).getByRole('button', { name: /Longtail/ }));
    await waitFor(() => expect(titles('Now')).toEqual(['Ship the Longtail beta']));
    expect(titles('Today')).toEqual([]);
    expect(within(band('Today')).getByText('Nothing for Longtail in this band.')).toBeTruthy();
    await waitFor(() => expect(controls.setTabCount).toHaveBeenLastCalledWith('dashboard', 1));
  });

  it('files the selected row with b', async () => {
    const longtail = await projects.create({ name: 'Longtail', code: 'LT', accent: 'blue' });
    renderSheet();
    await loaded();
    await press('b');
    const picker = await screen.findByRole('dialog', { name: 'Badge picker' });
    const combobox = within(picker).getByRole('combobox');
    fireEvent.change(combobox, { target: { value: 'lt' } });
    act(() => {
      fireEvent.keyDown(combobox, { key: 'Enter' });
    });
    await waitFor(() =>
      expect(store.query({ titleContains: 'outage' })[0]?.filing).toEqual({
        projectId: longtail.id,
        filedBy: 'user',
      }),
    );
  });

  it('reads again after a Linear sync, without being reopened', async () => {
    renderSheet();
    await loaded();
    saveIssues(issue({ identifier: 'ENG-6', title: 'New urgent thing', assignee: SAM, priority: 1 }));
    expect(titles('Now')).toHaveLength(2);
    accounts.change([acme(NOW)]);
    await waitFor(() => expect(titles('Now')).toContain('ENG-6 New urgent thing'));
  });

  it('opens Notes from the Daily Note card, and Todos from its open Todos', async () => {
    renderSheet();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /Open the Daily Note/ }));
    expect(controls.openSection).toHaveBeenLastCalledWith('notes');
    fireEvent.click(screen.getByRole('button', { name: /3 open Todos/ }));
    expect(controls.openSection).toHaveBeenLastCalledWith('todos');
  });
});
