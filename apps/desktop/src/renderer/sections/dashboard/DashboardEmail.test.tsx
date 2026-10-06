// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { EmailDetail, SourceItem } from '@commander/domain';
import { Toaster } from '@commander/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onReveal } from '../../frame/reveal';
import type { ItemStoreClient } from '../../item-store/client';
import { openTestItemStore } from '../../item-store/test-item-store';
import { ProjectsProvider } from '../../projects/context';
import { type ProjectsClient, projectsIn } from '../../projects/projects';
import { ShortcutProvider, ShortcutScope, useActiveScopes } from '../../shortcuts/react';
import { makeEmailTodo } from '../email/email-todo';
import type { LinearAccountsClient } from '../linear/linear-issues';
import { FrameControlsProvider, SectionProvider } from '../section';
import { dashboard as definition } from '.';
import { DashboardProvider } from './context';
import { DashboardSheet } from './DashboardSheet';
import { type DashboardClient, dashboardIn } from './dashboard';

// Email on the Dashboard (#137): threads in Needs reply in Today, threads in Waiting on others with no
// answer for 3 days in Waiting on others, ranked by the band rules; every other Bucket and Unsorted
// mail stays in the Email Section; `t` makes an email row a Todo (#140). The clock is fixed: Thursday
// 1 October 2026, 11:40.

const NOW = new Date(2026, 9, 1, 11, 40).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let store: ItemStore;
let projects: ProjectsClient;
let client: DashboardClient;
let itemStore: ItemStoreClient;
let close: () => void;
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };
const accounts: LinearAccountsClient = {
  list: async () => [],
  syncNow: async () => {},
  onChange: () => () => {},
};

function mail(id: string, fields: Partial<EmailDetail> = {}): SourceItem {
  const detail: EmailDetail = {
    kind: 'email',
    messageId: `<${id}@mail.test>`,
    inReplyTo: null,
    references: [],
    threadKey: `mid:<${id}@mail.test>`,
    sourceThreadId: id,
    from: { name: 'Dana Whitfield', address: 'dana@northwind.test' },
    to: [{ name: 'Alex Kim', address: 'alex@gmail.test' }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: `Subject ${id}`,
    sentAt: NOW - HOUR,
    snippet: '',
    read: true,
    starred: false,
    inInbox: true,
    sentByMe: false,
    labels: [{ id: 'INBOX', name: 'Inbox' }],
    attachments: [],
    hasInvitation: false,
    listUnsubscribe: null,
    listId: null,
    ...fields,
  };
  return { externalId: id, kind: 'email', title: detail.subject, status: 'open', detail };
}

const idOf = (externalId: string) =>
  store.query({ kinds: ['email'] }).find((item) => item.externalId === externalId)?.id ?? '';
const sortInto = (externalId: string, bucketId: string) =>
  store.record(
    { type: 'edit-fields', itemId: idOf(externalId), fields: { bucket: { bucketId, sortedBy: 'user' } } },
    { by: { kind: 'user' } },
  );

beforeEach(() => {
  const opened = openTestItemStore(() => NOW);
  ({ store, close } = opened);
  itemStore = opened.client;
  projects = projectsIn(opened.client);
  client = dashboardIn(opened.client, accounts, undefined, () => NOW);
  localStorage.clear();
  for (const mock of Object.values(controls)) mock.mockReset();
  Element.prototype.scrollIntoView = () => {};
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  store.saveFromSource({
    source: 'gmail',
    account: 'google:alex',
    items: [
      mail('offsite', { subject: 'Q4 offsite dates', sentAt: new Date(2026, 8, 29, 16, 5).getTime() }),
      mail('contract', {
        subject: 'Signed contract?',
        sentByMe: true,
        from: { name: 'Alex Kim', address: 'alex@gmail.test' },
        to: [{ name: 'Leo Brandt', address: 'leo@contoso.test' }],
        sentAt: NOW - 4 * DAY - HOUR,
      }),
      mail('receipt', { subject: 'Your receipt', from: { name: 'Shop', address: 'orders@shop.test' } }),
      mail('unsorted', { subject: 'Hello there' }),
    ],
  });
  sortInto('offsite', 'needs-reply');
  sortInto('contract', 'waiting-on-others');
  sortInto('receipt', 'receipts');
});

afterEach(() => {
  cleanup();
  close();
  vi.useRealTimers();
});

function Active({ children }: { children: ReactNode }) {
  useActiveScopes(['dashboard']);
  return children;
}

function renderSheet() {
  return render(
    <ShortcutProvider>
      <ProjectsProvider client={projects} storage={localStorage}>
        <DashboardProvider client={client} storage={localStorage} clock={() => NOW}>
          <FrameControlsProvider value={controls}>
            <SectionProvider place={{ definition, number: 1, total: 8, active: true }}>
              <ShortcutScope scope="dashboard" group="Dashboard">
                <Active>
                  <DashboardSheet makeTodo={(draft) => makeEmailTodo(itemStore, draft)} />
                </Active>
              </ShortcutScope>
            </SectionProvider>
          </FrameControlsProvider>
        </DashboardProvider>
      </ProjectsProvider>
      <Toaster />
    </ShortcutProvider>,
  );
}

const band = (name: string) => screen.getByRole('region', { name });
const titles = (name: string) =>
  within(band(name))
    .queryAllByTestId('dashboard-row')
    .map((row) => row.getAttribute('aria-label'));
const row = (title: string) => screen.getByRole('listitem', { name: title });

describe('email on the Dashboard', () => {
  it('shows Needs reply in Today and a stale Waiting on others in Waiting on others, stamped EML', async () => {
    renderSheet();
    await waitFor(() => expect(titles('Today')).toEqual(['Q4 offsite dates']));
    expect(titles('Waiting on others')).toEqual(['Signed contract?']);
    expect(screen.queryByRole('listitem', { name: 'Your receipt' })).toBeNull();
    expect(screen.queryByRole('listitem', { name: 'Hello there' })).toBeNull();

    const offsite = row('Q4 offsite dates');
    expect(within(offsite).getByTestId('row-reason').textContent).toBe(
      'Dana’s waiting on your reply since Tuesday',
    );
    expect(within(offsite).getByTestId('source-stamp').textContent).toBe('EMLNeeds reply');
    expect(within(row('Signed contract?')).getByTestId('row-reason').textContent).toBe(
      'No reply from Leo for 4 days',
    );
    // Nothing to tick: an email is dealt with in the Email Section.
    expect(within(offsite).queryByRole('button', { name: /Tick/ })).toBeNull();
  });

  it('opens the thread in the Email Section with Enter, and e clears the row', async () => {
    renderSheet();
    await waitFor(() => expect(titles('Today')).toEqual(['Q4 offsite dates']));
    const heard: string[] = [];
    const stop = onReveal('email', (itemId) => heard.push(itemId));
    fireEvent.click(row('Q4 offsite dates'));
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Enter' });
    });
    expect(controls.openSection).toHaveBeenLastCalledWith('email');
    expect(heard).toEqual([idOf('offsite')]);
    stop();

    act(() => {
      fireEvent.keyDown(document.body, { key: 'e' });
    });
    await waitFor(() => expect(titles('Today')).toEqual([]));
  });

  it('t makes the email a Todo, from email and linked to it, and Ctrl+Z takes it back', async () => {
    renderSheet();
    await waitFor(() => expect(titles('Today')).toEqual(['Q4 offsite dates']));
    fireEvent.click(row('Q4 offsite dates'));
    act(() => {
      fireEvent.keyDown(document.body, { key: 't' });
    });
    const dialog = await screen.findByRole('dialog', { name: 'Make it a Todo' });
    expect(dialog.textContent).toContain('From email · Dana Whitfield');
    fireEvent.click(within(dialog).getByRole('button', { name: /Add Todo/ }));

    await screen.findByText('Todo added: Q4 offsite dates');
    const [todo] = store.query({ kinds: ['todo'] });
    expect(todo).toMatchObject({ title: 'Q4 offsite dates', detail: { origin: 'email' } });
    expect(store.get(todo?.id ?? '')?.links.map((link) => link.to.id)).toEqual([idOf('offsite')]);

    act(() => {
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    });
    await waitFor(() => expect(store.query({ kinds: ['todo'] })).toEqual([]));
  });
});
