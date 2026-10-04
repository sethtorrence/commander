// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { EmailBody, EmailDetail, Project, SourceItem } from '@commander/domain';
import type { AccountSyncStatus, GoogleAccountSummary } from '@commander/domain/ipc';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemChanges } from '../../item-store/changes';
import { openTestItemStore } from '../../item-store/test-item-store';
import { ProjectsProvider } from '../../projects/context';
import { type ProjectsClient, projectsIn } from '../../projects/projects';
import { ShortcutProvider, ShortcutScope, useActiveScopes } from '../../shortcuts/react';
import { FrameControlsProvider, SectionProvider } from '../section';
import { email as definition } from '.';
import { EmailSheet } from './EmailSheet';
import { type EmailAccountsClient, type EmailClient, emailIn } from './email';

// The Email Section against a real Item store on a temporary database, with mail saved the way Gmail
// sync saves it (saveFromSource), and a stand-in for the email Accounts.

const ALEX = 'google:alex';
const SAM = 'google:sam';
const HOUR = 60 * 60_000;
const NOW = new Date(2026, 9, 3, 15, 0).getTime();

let store: ItemStore;
let client: EmailClient;
let changes: ItemChanges;
let projects: ProjectsClient;
let close: () => void;
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };

function fakeAccounts(initial: GoogleAccountSummary[]) {
  let accounts = initial;
  const listeners = new Set<(accounts: GoogleAccountSummary[]) => void>();
  const refreshed: string[] = [];
  const accountsClient: EmailAccountsClient = {
    list: async () => accounts,
    refresh: async (id) => {
      refreshed.push(id);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    client: accountsClient,
    refreshed,
    change(next: GoogleAccountSummary[]) {
      accounts = next;
      act(() => {
        for (const listener of listeners) listener(next);
      });
    },
  };
}

const syncStatus = (account: string, overrides: Partial<AccountSyncStatus> = {}): AccountSyncStatus => ({
  account,
  source: 'gmail',
  activity: 'idle',
  cadenceMinutes: 15,
  cadenceChoices: [5, 10, 15, 30, 60],
  lastSyncedAt: new Date(2026, 9, 3, 14, 2).getTime(),
  nextSyncAt: null,
  itemCount: 3,
  problem: null,
  outgoing: { pending: 0, failed: 0 },
  ...overrides,
});

const google = (
  id: string,
  address: string,
  sync: AccountSyncStatus | null = syncStatus(id),
): GoogleAccountSummary => ({
  id,
  source: 'google',
  name: `Google · ${address}`,
  email: address,
  method: 'oauth',
  status: 'connected',
  user: null,
  sync,
  sources: [
    { source: 'gmail', granted: true, enabled: true },
    { source: 'google-calendar', granted: true, enabled: true },
  ],
});

type Spec = Partial<EmailDetail> & { text?: string; html?: string | null; textFromHtml?: boolean };

function mail(id: string, spec: Spec = {}): SourceItem {
  const { text = `Body of ${id}`, html = null, textFromHtml = false, ...fields } = spec;
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
    read: false,
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
  const body: EmailBody = { text, html, textFromHtml, truncated: false };
  return {
    externalId: id,
    kind: 'email',
    title: detail.subject,
    people: [],
    status: detail.inInbox ? 'open' : 'archived',
    detail,
    body,
  };
}

const reply = (id: string, parent: SourceItem, spec: Spec = {}) => {
  const of = parent.detail as EmailDetail;
  return mail(id, {
    inReplyTo: of.messageId,
    references: [of.messageId as string],
    subject: `Re: ${of.subject}`,
    ...spec,
  });
};

const offsite = mail('a', {
  subject: 'Q4 offsite dates',
  sentAt: NOW - 5 * HOUR,
  read: true,
  text: 'Which dates work for you?\n\nDana',
});
const answer = reply('b', offsite, {
  sentAt: NOW - 4 * HOUR,
  read: true,
  sentByMe: true,
  from: { name: 'Alex Kim', address: 'alex@gmail.test' },
  to: [{ name: 'Dana Whitfield', address: 'dana@northwind.test' }],
  text: '19–21 Nov works best.',
});
const booked = reply('c', answer, {
  sentAt: NOW - HOUR,
  text: '<b>Booked</b> the venue.',
  snippet: 'Booked the venue.',
});
const receipt = mail('r', {
  subject: 'Your order has shipped',
  from: { name: 'Shop', address: 'orders@shop.test' },
  sentAt: NOW - 30 * 60_000,
  read: true,
  text: 'Your order is on its way\n\nTrack your parcel (https://shop.test/track)',
  html: '<h1>Your order is on its way</h1>',
  textFromHtml: true,
  attachments: [{ name: 'invoice.pdf', type: 'application/pdf', size: 4000, partId: '2', inline: false }],
});
const samsMail = mail('s', {
  subject: 'Standup notes',
  from: { name: 'Lee Chen', address: 'lee@work.test' },
  sentAt: NOW - 2 * HOUR,
});

let accounts: ReturnType<typeof fakeAccounts>;

beforeEach(() => {
  const opened = openTestItemStore();
  ({ store, close, changes } = opened);
  client = emailIn(opened.client);
  projects = projectsIn(opened.client);
  accounts = fakeAccounts([google(ALEX, 'alex@gmail.test'), google(SAM, 'sam@work.test')]);
  localStorage.clear();
  controls.openSection.mockReset();
  controls.setTabCount.mockReset();
  Element.prototype.scrollIntoView = () => {};
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  store.saveFromSource({ source: 'gmail', account: ALEX, items: [offsite, answer, booked, receipt] });
  store.saveFromSource({ source: 'gmail', account: SAM, items: [samsMail] });
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

const place = { definition, number: 5, total: 8, active: true };

function renderSheet() {
  return render(
    <ShortcutProvider>
      <ProjectsProvider client={projects} storage={localStorage}>
        <FrameControlsProvider value={controls}>
          <SectionProvider place={place}>
            <ShortcutScope scope="email" group="Email">
              <Active>
                <EmailSheet client={client} accounts={accounts.client} changes={changes} />
              </Active>
            </ShortcutScope>
          </SectionProvider>
        </FrameControlsProvider>
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
const reader = () => screen.queryByRole('region', { name: 'Thread' });

describe('the Email sheet', () => {
  it('lists the inbox as threads across Accounts, newest first, with who wrote, counts and unread weight', async () => {
    renderSheet();
    await waitFor(() =>
      expect(subjects()).toEqual(['Your order has shipped', 'Re: Re: Q4 offsite dates', 'Standup notes']),
    );

    const [shipped, conversation, standup] = rows();
    expect(within(conversation as HTMLElement).getByTestId('thread-senders').textContent).toBe(
      'Dana Whitfield, me',
    );
    expect(within(conversation as HTMLElement).getByTestId('thread-count').textContent).toBe('3');
    expect(conversation?.getAttribute('data-unread')).toBe('true');
    expect(shipped?.getAttribute('data-unread')).toBe('false');
    expect(within(shipped as HTMLElement).getByLabelText('Has attachments')).toBeTruthy();
    expect(within(standup as HTMLElement).getByText('sam@work.test')).toBeTruthy();
    expect(within(conversation as HTMLElement).getByTestId('thread-time').textContent).toBe('14:00');
    // The Email tab counts the inbox's unread threads.
    await waitFor(() => expect(controls.setTabCount).toHaveBeenLastCalledWith('email', 2));
  });

  it('narrows to one Account with the Account switcher, and back to all', async () => {
    renderSheet();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const switcher = screen.getByRole('tablist', { name: 'Account' });
    expect(
      within(switcher)
        .getAllByRole('tab')
        .map((tab) => tab.getAttribute('aria-label')),
    ).toEqual(['All Accounts', 'alex@gmail.test', 'sam@work.test']);

    fireEvent.click(within(switcher).getByRole('tab', { name: 'sam@work.test' }));
    await waitFor(() => expect(subjects()).toEqual(['Standup notes']));
    // One Account's threads don't name the Account.
    expect(within(rows()[0] as HTMLElement).queryByText('sam@work.test')).toBeNull();

    fireEvent.click(within(switcher).getByRole('tab', { name: 'All Accounts' }));
    await waitFor(() => expect(rows()).toHaveLength(3));
  });

  it('opens a thread with Enter: every message with its headers and its plain-text body', async () => {
    renderSheet();
    await waitFor(() => expect(rows()).toHaveLength(3));

    press('j');
    press('Enter');

    const thread = await waitFor(() => {
      const found = reader();
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await waitFor(() => expect(within(thread).getAllByTestId('email-message')).toHaveLength(3));
    expect(within(thread).getByRole('heading', { name: 'Re: Re: Q4 offsite dates' })).toBeTruthy();
    const [first, second, third] = within(thread).getAllByTestId('email-message');
    expect(within(first as HTMLElement).getByText('Dana Whitfield <dana@northwind.test>')).toBeTruthy();
    expect(within(first as HTMLElement).getByTestId('email-body').textContent).toBe(
      'Which dates work for you?\n\nDana',
    );
    expect(within(second as HTMLElement).getByText('Alex Kim <alex@gmail.test>')).toBeTruthy();
    // A body is only ever text: markup in it is shown as it is, never rendered.
    expect(within(third as HTMLElement).getByTestId('email-body').textContent).toBe(
      '<b>Booked</b> the venue.',
    );
    expect(
      within(third as HTMLElement)
        .getByTestId('email-body')
        .querySelector('b'),
    ).toBeNull();

    press('Escape');
    expect(reader()).toBeNull();
  });

  it('shows an HTML-only message as its text conversion', async () => {
    renderSheet();
    await waitFor(() => expect(rows()).toHaveLength(3));

    fireEvent.click(rows()[0] as HTMLElement);

    const thread = await waitFor(() => reader() as HTMLElement);
    await waitFor(() =>
      expect(within(thread).getByTestId('email-body').textContent).toBe(
        'Your order is on its way\n\nTrack your parcel (https://shop.test/track)',
      ),
    );
    expect(within(thread).getByText('invoice.pdf')).toBeTruthy();
    expect(thread.querySelector('h1')).toBeNull();
  });

  it('asks every email Account to sync when it opens, and on Refresh', async () => {
    renderSheet();
    await waitFor(() => expect(accounts.refreshed.sort()).toEqual([ALEX, SAM]));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(accounts.refreshed).toHaveLength(4));
  });

  it('shows the status line: the first download’s progress, then when mail synced', async () => {
    accounts = fakeAccounts([
      google(
        ALEX,
        'alex@gmail.test',
        syncStatus(ALEX, { activity: 'syncing', lastSyncedAt: null, progress: { done: 1240, total: 3000 } }),
      ),
    ]);
    renderSheet();

    await waitFor(() =>
      expect(screen.getByTestId('email-sync-status').textContent).toBe(
        'Downloading 30 days: 1,240 of ~3,000',
      ),
    );

    accounts.change([google(ALEX, 'alex@gmail.test')]);
    await waitFor(() => expect(screen.getByTestId('email-sync-status').textContent).toBe('Synced 14:02'));
  });

  it('reads the threads again as mail arrives', async () => {
    renderSheet();
    await waitFor(() => expect(rows()).toHaveLength(3));

    store.saveFromSource({
      source: 'gmail',
      account: ALEX,
      items: [mail('new', { subject: 'Staging certificate', sentAt: NOW - 60_000 })],
    });
    accounts.change([
      google(ALEX, 'alex@gmail.test', syncStatus(ALEX, { lastSyncedAt: NOW })),
      google(SAM, 'sam@work.test'),
    ]);

    await waitFor(() => expect(subjects()[0]).toBe('Staging certificate'));
  });

  it('files a whole thread under a Project with b', async () => {
    const created = await projects.change({
      type: 'create',
      project: { name: 'Longtail', code: 'LT', accent: 'blue' },
    });
    const project = created.project as Project;
    renderSheet();
    await waitFor(() => expect(rows()).toHaveLength(3));

    press('j');
    press('b');
    const picker = await screen.findByRole('dialog');
    fireEvent.click(within(picker).getByRole('option', { name: /Longtail/ }));

    await waitFor(() => {
      const filed = store.query({ kinds: ['email'], projectId: project.id }).map((item) => item.externalId);
      expect(filed.sort()).toEqual(['a', 'b', 'c']);
    });
  });

  it('says how to connect an email Account when there is none', async () => {
    accounts = fakeAccounts([]);
    renderSheet();

    await screen.findByText(
      'No email Account connected yet. Connect a Google Account in Settings → Accounts (,).',
    );
    // With nothing to count, the Email tab shows no count.
    expect(controls.setTabCount).not.toHaveBeenCalledWith('email', 0);
    expect(controls.setTabCount).toHaveBeenLastCalledWith('email', null);
  });
});
