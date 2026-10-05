// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { EmailDetail, Project, SourceItem } from '@commander/domain';
import type { GoogleAccountSummary } from '@commander/domain/ipc';
import { Toaster } from '@commander/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemChanges } from '../../item-store/changes';
import { openTestItemStore } from '../../item-store/test-item-store';
import { ProjectsProvider } from '../../projects/context';
import { FILTER_STORAGE_KEY } from '../../projects/filter';
import { type ProjectsClient, projectsIn } from '../../projects/projects';
import { ShortcutProvider, ShortcutScope, useActiveScopes, useShortcutList } from '../../shortcuts/react';
import { FrameControlsProvider, SectionProvider } from '../section';
import { email as definition } from '.';
import { EmailSheet } from './EmailSheet';
import { type EmailAccountsClient, type EmailClient, emailIn } from './email';

// Buckets in the Email Section (#137), against a real Item store: each thread's Bucket on its row, the
// Bucket strip's counts combined with the views and the Project filter, `v` moving a thread (by the
// User, undoable), and the Email tab counting unread threads in Needs reply.

const ALEX = 'google:alex';
const HOUR = 60 * 60_000;
const NOW = new Date(2026, 9, 7, 15, 0).getTime();

let store: ItemStore;
let client: EmailClient;
let changes: ItemChanges;
let projects: ProjectsClient;
let close: () => void;
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };

const accounts: EmailAccountsClient = {
  list: async (): Promise<GoogleAccountSummary[]> => [
    {
      id: ALEX,
      source: 'google',
      name: 'Google · alex@gmail.test',
      email: 'alex@gmail.test',
      method: 'oauth',
      status: 'connected',
      user: null,
      sync: null,
      sources: [{ source: 'gmail', granted: true, enabled: true }],
    },
  ],
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
  return { externalId: id, kind: 'email', title: detail.subject, status: 'open', detail };
}

const idOf = (externalId: string) =>
  store.query({ kinds: ['email'] }).find((item) => item.externalId === externalId)?.id ?? '';
const bucketOf = (externalId: string) =>
  (store.get(idOf(externalId))?.item.detail as EmailDetail | undefined)?.bucket ?? null;
const sortInto = (externalId: string, bucketId: string) =>
  store.record(
    { type: 'edit-fields', itemId: idOf(externalId), fields: { bucket: { bucketId, sortedBy: 'user' } } },
    { by: { kind: 'user' } },
  );

beforeEach(() => {
  const opened = openTestItemStore();
  ({ store, close, changes } = opened);
  client = emailIn(opened.client);
  projects = projectsIn(opened.client);
  localStorage.clear();
  controls.setTabCount.mockReset();
  Element.prototype.scrollIntoView = () => {};
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  store.saveFromSource({
    source: 'gmail',
    account: ALEX,
    items: [
      mail('offsite', { subject: 'Q4 offsite dates', sentAt: NOW - 2 * HOUR, read: false }),
      mail('receipt', { subject: 'Your order has shipped', sentAt: NOW - HOUR }),
      mail('standup', { subject: 'Standup notes', sentAt: NOW - 3 * HOUR }),
    ],
  });
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
const strip = () => screen.getByRole('tablist', { name: 'Bucket' });
const stripTabs = () =>
  within(strip())
    .getAllByRole('tab')
    .map((tab) => tab.textContent);
const chipOf = (subject: string) =>
  rows()
    .find((row) => within(row).getByTestId('thread-subject').textContent === subject)
    ?.querySelector('[data-slot="bucket"]')?.textContent;

describe('Buckets in the Email Section', () => {
  it('shows each thread’s Bucket, and the strip counts and filters by Bucket', async () => {
    sortInto('receipt', 'receipts');
    sortInto('offsite', 'needs-reply');
    renderSheet();
    await waitFor(() => expect(subjects()).toHaveLength(3));
    expect(chipOf('Your order has shipped')).toBe('Receipts');
    expect(chipOf('Q4 offsite dates')).toBe('Needs reply');
    expect(chipOf('Standup notes')).toBe('Unsorted');

    // Needs reply first, then the User's order, then Unsorted; each with its count.
    await waitFor(() =>
      expect(stripTabs()).toEqual([
        'All3',
        'Needs reply1',
        'Waiting on others',
        'FYI',
        'Newsletters',
        'Receipts1',
        'Calendar',
        'Junk',
        'Unsorted1',
      ]),
    );

    fireEvent.click(within(strip()).getByRole('tab', { name: /^Receipts/ }));
    await waitFor(() => expect(subjects()).toEqual(['Your order has shipped']));
    fireEvent.click(within(strip()).getByRole('tab', { name: /^Unsorted/ }));
    await waitFor(() => expect(subjects()).toEqual(['Standup notes']));
    fireEvent.click(within(strip()).getByRole('tab', { name: /^All/ }));
    await waitFor(() => expect(subjects()).toHaveLength(3));
  });

  it('combines the strip’s counts with the Project filter and the views', async () => {
    const lt = (
      await projects.change({ type: 'create', project: { name: 'Longtail', code: 'LT', accent: 'blue' } })
    ).project as Project;
    store.record(
      { type: 'update', itemId: idOf('standup'), changes: { filing: { projectId: lt.id, filedBy: 'user' } } },
      { by: { kind: 'user' } },
    );
    sortInto('receipt', 'receipts');
    localStorage.setItem(FILTER_STORAGE_KEY, lt.id);
    renderSheet();
    await waitFor(() => expect(subjects()).toEqual(['Standup notes']));
    await waitFor(() => expect(stripTabs()[0]).toBe('All1'));
    expect(stripTabs().at(-1)).toBe('Unsorted1');
    expect(stripTabs()).toContain('Receipts');

    // Archive: nothing there yet, whatever the Bucket.
    fireEvent.click(
      within(screen.getByRole('tablist', { name: 'View' })).getByRole('tab', { name: /^Archive/ }),
    );
    await waitFor(() => expect(stripTabs()[0]).toBe('All'));
  });

  it('moves a thread with v, recorded as the User’s, and Undo puts it back', async () => {
    renderSheet();
    await waitFor(() => expect(subjects()).toHaveLength(3));

    press('v');
    const picker = await screen.findByRole('dialog', { name: 'Move to a Bucket' });
    fireEvent.click(within(picker).getByRole('option', { name: /Receipts/ }));

    await waitFor(() => expect(bucketOf('receipt')).toEqual({ bucketId: 'receipts', sortedBy: 'user' }));
    expect(store.activity({ itemId: idOf('receipt'), limit: 1 })[0]?.by).toEqual({ kind: 'user' });
    await waitFor(() => expect(chipOf('Your order has shipped')).toBe('Receipts'));
    const toast = await screen.findByText('Moved to Receipts: Your order has shipped');
    fireEvent.click(
      within(toast.closest('[data-sonner-toast]') as HTMLElement).getByRole('button', { name: 'Undo' }),
    );
    await waitFor(() => expect(bucketOf('receipt')).toBeNull());

    // From the keyboard: the picker's numbers, and Unsorted.
    press('v');
    const again = await screen.findByRole('dialog', { name: 'Move to a Bucket' });
    act(() => {
      fireEvent.keyDown(again, { key: '1' });
    });
    await waitFor(() => expect(bucketOf('receipt')).toEqual({ bucketId: 'needs-reply', sortedBy: 'user' }));
    press('z', { ctrlKey: true });
    await waitFor(() => expect(bucketOf('receipt')).toBeNull());

    expect(screen.getByTestId('key-list').textContent).toContain('V Move to a Bucket');
  });

  it('counts unread threads in Needs reply on the Email tab', async () => {
    renderSheet();
    await waitFor(() => expect(subjects()).toHaveLength(3));
    await waitFor(() => expect(controls.setTabCount).toHaveBeenLastCalledWith('email', 0));
    // Through the window's client, so the Section hears of the change.
    await act(() =>
      client.edit(
        ['offsite', 'receipt'].map((id) => ({
          itemId: idOf(id),
          fields: { bucket: { bucketId: 'needs-reply', sortedBy: 'user' } },
        })),
      ),
    );
    await waitFor(() => expect(controls.setTabCount).toHaveBeenLastCalledWith('email', 1));
  });
});
