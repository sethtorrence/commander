// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { EmailDetail, SourceItem } from '@commander/domain';
import type { GoogleAccountSummary } from '@commander/domain/ipc';
import { Toaster } from '@commander/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemChanges } from '../../item-store/changes';
import { openTestItemStore } from '../../item-store/test-item-store';
import { ProjectsProvider } from '../../projects/context';
import { type ProjectsClient, projectsIn } from '../../projects/projects';
import { ShortcutProvider, ShortcutScope, useActiveScopes, useShortcutList } from '../../shortcuts/react';
import { FrameControlsProvider, SectionProvider } from '../section';
import { email as definition } from '.';
import { EmailSheet } from './EmailSheet';
import { type EmailAccountsClient, type EmailClient, emailIn } from './email';
import { MARK_READ_STORAGE_KEY } from './organising';

// Organising mail in the Email Section (#135), against a real Item store: archive, Trash, star, read
// and unread, labels and snooze from the keyboard and the open thread's buttons, each undoable; the
// views; Section search with Gmail's own search at the end; and Couldn't sync with Retry.

const ALEX = 'google:alex';
const SAM = 'google:sam';
const HOUR = 60 * 60_000;
// Wednesday 7 October 2026, 15:00.
const NOW = new Date(2026, 9, 7, 15, 0).getTime();

let store: ItemStore;
let client: EmailClient;
let changes: ItemChanges;
let projects: ProjectsClient;
let close: () => void;
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };

const google = (id: string, email: string): GoogleAccountSummary => ({
  id,
  source: 'google',
  name: `Google · ${email}`,
  email,
  method: 'oauth',
  status: 'connected',
  user: null,
  sync: null,
  sources: [{ source: 'gmail', granted: true, enabled: true }],
});

const accounts: EmailAccountsClient = {
  list: async () => [google(ALEX, 'alex@gmail.test'), google(SAM, 'sam@work.test')],
  refresh: async () => {},
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
    snippet: `Snippet ${id}`,
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
  return {
    externalId: id,
    kind: 'email',
    title: detail.subject,
    people: [],
    status: detail.inInbox ? 'open' : 'archived',
    detail,
    body: { text: `Body of ${id}`, html: null, textFromHtml: false, truncated: false },
  };
}

beforeEach(() => {
  // The clock is faked first, so the Item store keeps the same time as the window.
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  const opened = openTestItemStore();
  ({ store, close, changes } = opened);
  client = emailIn(opened.client);
  projects = projectsIn(opened.client);
  localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
  store.saveFromSource({
    source: 'gmail',
    account: ALEX,
    items: [
      mail('offsite', { subject: 'Q4 offsite dates', sentAt: NOW - 2 * HOUR, read: false }),
      mail('receipt', {
        subject: 'Your order has shipped',
        from: { name: 'Shop', address: 'orders@shop.test' },
        sentAt: NOW - HOUR,
      }),
    ],
  });
  store.saveFromSource({
    source: 'gmail',
    account: SAM,
    items: [mail('standup', { subject: 'Standup notes', sentAt: NOW - 3 * HOUR })],
  });
  store.syncState.saveCatalog(
    ALEX,
    'gmail',
    {
      kind: 'gmail',
      labels: [
        { id: 'INBOX', name: 'Inbox', system: true },
        { id: 'Label_1', name: 'Receipts', system: false },
      ],
    },
    NOW,
  );
});

afterEach(() => {
  cleanup();
  close();
  vi.useRealTimers();
});

function Active({ children }: { children: ReactNode }) {
  useActiveScopes(['email']);
  return children;
}

function KeyList() {
  const list = useShortcutList();
  return (
    <ul data-testid="key-list">
      {list.map((each) => (
        <li key={`${each.scope}:${each.keys.join('+')}`}>{`${each.keys.join('+')} ${each.label}`}</li>
      ))}
    </ul>
  );
}

function renderSheet() {
  return render(
    <ShortcutProvider>
      <ProjectsProvider client={projects} storage={localStorage}>
        <FrameControlsProvider value={controls}>
          <SectionProvider place={{ definition, number: 5, total: 8, active: true }}>
            <ShortcutScope scope="email" group="Email">
              <Active>
                <EmailSheet client={client} accounts={accounts} changes={changes} />
              </Active>
            </ShortcutScope>
          </SectionProvider>
        </FrameControlsProvider>
        <KeyList />
        <Toaster />
      </ProjectsProvider>
    </ShortcutProvider>,
  );
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(document.body, { key, ...init });
  });

const rows = () => screen.queryAllByTestId('email-thread');
const subjects = () => rows().map((row) => within(row).getByTestId('thread-subject').textContent);
const views = () => screen.getByRole('tablist', { name: 'View' });
const openView = (name: RegExp) => fireEvent.click(within(views()).getByRole('tab', { name }));
const reader = () => screen.getByRole('region', { name: 'Thread' });

async function loaded() {
  renderSheet();
  await waitFor(() =>
    expect(subjects()).toEqual(['Your order has shipped', 'Q4 offsite dates', 'Standup notes']),
  );
}

describe('organising mail', () => {
  it('archives the selected thread with e, into Archive, and Undo brings it back', async () => {
    await loaded();

    press('e');

    await waitFor(() => expect(subjects()).toEqual(['Q4 offsite dates', 'Standup notes']));
    const toast = await screen.findByText('Archived: Your order has shipped');
    expect(store.outgoing.list().map((change) => change.field)).toEqual(['inbox']);
    openView(/^Archive/);
    await waitFor(() => expect(subjects()).toEqual(['Your order has shipped']));

    fireEvent.click(
      within(toast.closest('[data-sonner-toast]') as HTMLElement).getByRole('button', { name: 'Undo' }),
    );
    await waitFor(() => expect(subjects()).toEqual([]));
    openView(/^Inbox/);
    await waitFor(() => expect(subjects()).toHaveLength(3));
    expect(store.outgoing.list()).toEqual([]);
  });

  it('undoes the last change with Ctrl+Z', async () => {
    await loaded();
    press('e');
    await waitFor(() => expect(subjects()).toHaveLength(2));

    press('z', { ctrlKey: true });

    await waitFor(() => expect(subjects()).toHaveLength(3));
  });

  it('stars with s, and marks read and unread with Shift+I and Shift+U', async () => {
    await loaded();
    press('j');

    press('s');
    await waitFor(() => expect(within(rows()[1] as HTMLElement).getByLabelText('Starred')).toBeTruthy());
    press('I', { shiftKey: true });
    await waitFor(() => expect(rows()[1]?.getAttribute('data-unread')).toBe('false'));
    press('U', { shiftKey: true });
    await waitFor(() => expect(rows()[1]?.getAttribute('data-unread')).toBe('true'));

    openView(/^Starred/);
    await waitFor(() => expect(subjects()).toEqual(['Q4 offsite dates']));
  });

  it('moves a thread to Trash with #, out of the inbox, and Move to inbox brings it back; nothing deletes for good', async () => {
    await loaded();

    press('#');
    await waitFor(() => expect(subjects()).toEqual(['Q4 offsite dates', 'Standup notes']));
    openView(/^Trash/);
    await waitFor(() => expect(subjects()).toEqual(['Your order has shipped']));

    press('Enter');
    const pane = await waitFor(() => reader());
    expect(within(pane).queryByRole('button', { name: /delete/i })).toBeNull();
    fireEvent.click(within(pane).getByRole('button', { name: /Move to inbox/ }));

    await waitFor(() => expect(subjects()).toEqual([]));
    openView(/^Inbox/);
    await waitFor(() => expect(subjects()).toHaveLength(3));
  });

  it('labels a thread with l, from the Account’s labels, and lists it under the label', async () => {
    await loaded();

    press('l');
    const picker = await screen.findByRole('dialog', { name: 'Labels' });
    fireEvent.click(within(picker).getByRole('checkbox', { name: 'Receipts' }));

    await waitFor(() => expect(within(rows()[0] as HTMLElement).getByText('Receipts')).toBeTruthy());
    expect(store.outgoing.list().map((change) => change.field)).toEqual(['label:Label_1']);
    press('Escape');
    openView(/^Receipts/);
    await waitFor(() => expect(subjects()).toEqual(['Your order has shipped']));
  });

  it('snoozes with z: the picker says Commander must be running, and the thread waits in Snoozed', async () => {
    await loaded();

    press('z');
    const picker = await screen.findByRole('dialog', { name: 'Snooze until' });
    expect(
      within(picker).getByText(
        'Snoozed mail comes back only while Commander is running (the window or the tray).',
      ),
    ).toBeTruthy();
    fireEvent.click(within(picker).getByRole('button', { name: /Tomorrow morning/ }));

    await waitFor(() => expect(subjects()).toEqual(['Q4 offsite dates', 'Standup notes']));
    expect(store.outgoing.list()).toEqual([]);
    openView(/^Snoozed/);
    await waitFor(() => expect(subjects()).toEqual(['Your order has shipped']));
    expect(within(rows()[0] as HTMLElement).getByText('Until Thu 08:00')).toBeTruthy();
  });

  it('snoozes until a picked time', async () => {
    await loaded();
    press('z');
    const picker = await screen.findByRole('dialog', { name: 'Snooze until' });

    fireEvent.change(within(picker).getByLabelText('Date and time'), {
      target: { value: '2026-10-09T13:30' },
    });
    fireEvent.click(within(picker).getByRole('button', { name: 'Snooze' }));

    await waitFor(() => expect(subjects()).toHaveLength(2));
    const snoozed = store.query({ kinds: ['email'] }).find((item) => item.externalId === 'receipt');
    expect((snoozed?.detail as EmailDetail | undefined)?.snooze).toEqual({
      until: new Date(2026, 9, 9, 13, 30).getTime(),
      returned: false,
    });
  });

  it('shows a thread back from snooze as such, at the top', async () => {
    store.recordAll(
      store.query({ kinds: ['email'] }).flatMap((item) =>
        item.externalId === 'standup'
          ? [
              {
                type: 'edit-fields' as const,
                itemId: item.id,
                fields: { snooze: { until: NOW - 60_000, returned: true } },
              },
            ]
          : [],
      ),
      { by: { kind: 'user' } },
    );
    renderSheet();

    await waitFor(() => expect(subjects()[0]).toBe('Standup notes'));
    expect(within(rows()[0] as HTMLElement).getByText('Snoozed until 14:59')).toBeTruthy();
  });

  it('offers the actions as buttons on the open thread, and opening it marks it read', async () => {
    await loaded();
    press('j');
    press('Enter');

    const pane = await waitFor(() => reader());
    for (const name of [/Archive/, /Trash/, /Star/, /Mark (un)?read/, /Labels/, /Snooze/])
      expect(within(pane).getByRole('button', { name })).toBeTruthy();
    await waitFor(() => expect(rows()[1]?.getAttribute('data-unread')).toBe('false'));
  });

  it('leaves an opened thread unread when the setting says never', async () => {
    localStorage.setItem(MARK_READ_STORAGE_KEY, 'never');
    await loaded();
    press('j');
    press('Enter');

    await waitFor(() => reader());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(rows()[1]?.getAttribute('data-unread')).toBe('true');
  });

  it('shows Couldn’t sync with Retry on a thread whose change failed', async () => {
    await loaded();
    press('e');
    await waitFor(() => expect(store.outgoing.list()).toHaveLength(1));
    const [change] = store.outgoing.list();
    store.outgoing.fail([change?.id as number], {
      error: 'Gmail couldn’t answer just now (HTTP 503).',
      failed: true,
      nextAttemptAt: null,
    });
    openView(/^Archive/);
    await waitFor(() => expect(subjects()).toEqual(['Your order has shipped']));
    press('Enter');

    const pane = await waitFor(() => reader());
    await within(pane).findByText(/Couldn’t sync/);
    fireEvent.click(within(pane).getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(store.outgoing.list()[0]?.status).toBe('pending'));
  });

  it('notes on the open thread when a change made in Gmail won over the User’s', async () => {
    store.saveFromSource({
      source: 'gmail',
      account: ALEX,
      items: [mail('receipt', { subject: 'Your order has shipped', starred: true, sentAt: NOW - HOUR })],
      why: 'Changed in Gmail at 14:02',
    });
    await loaded();

    press('Enter');

    const pane = await waitFor(() => reader());
    await within(pane).findByText('Changed in Gmail at 14:02');
  });

  it('counts each view, live', async () => {
    await loaded();
    const inbox = () => within(views()).getByRole('tab', { name: /^Inbox/ }).textContent;
    await waitFor(() => expect(inbox()).toBe('Inbox1'));

    press('j');
    press('e');

    await waitFor(() => expect(inbox()).toBe('Inbox'));
  });

  it('lists its keys for ?', async () => {
    await loaded();
    const keys = screen.getByTestId('key-list').textContent ?? '';
    for (const key of [
      'E Archive',
      '# Move to Trash',
      'S Star',
      'Shift+I Mark read',
      'Shift+U Mark unread',
      'L Labels',
      'Z Snooze',
      '/ Search',
    ])
      expect(keys).toContain(key);
  });
});

describe('searching the Section', () => {
  it('searches with / and its operators, newest first, ending with Search in Gmail for each Account', async () => {
    await loaded();

    press('/');
    const box = screen.getByRole('searchbox', { name: 'Search mail' });
    fireEvent.change(box, { target: { value: 'from:shop' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(subjects()).toEqual(['Your order has shipped']));
    const links = screen.getAllByRole('link', { name: /Search in Gmail/ });
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://mail.google.com/mail/?authuser=alex%40gmail.test#search/from%3Ashop',
      'https://mail.google.com/mail/?authuser=sam%40work.test#search/from%3Ashop',
    ]);

    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() => expect(subjects()).toHaveLength(3));
  });

  it('narrows to the Account switcher’s Account', async () => {
    await loaded();
    fireEvent.click(
      within(screen.getByRole('tablist', { name: 'Account' })).getByRole('tab', { name: 'sam@work.test' }),
    );
    await waitFor(() => expect(subjects()).toEqual(['Standup notes']));

    press('/');
    const box = screen.getByRole('searchbox', { name: 'Search mail' });
    fireEvent.change(box, { target: { value: 'notes' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(subjects()).toEqual(['Standup notes']));
    expect(screen.getAllByRole('link', { name: /Search in Gmail/ })).toHaveLength(1);
  });
});
