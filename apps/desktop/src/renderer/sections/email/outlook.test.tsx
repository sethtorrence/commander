// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { EmailDetail, SourceItem } from '@commander/domain';
import type { GoogleAccountSummary, OutlookAccountSummary } from '@commander/domain/ipc';
import { Toaster } from '@commander/ui';
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

// Outlook mail in the Email Section (#136), against a real Item store: its threads sit in the one inbox
// beside Gmail's and the Account switcher narrows to either; `l` on an Outlook thread opens Move to
// folder with the Account's folders, which are views too; a star is a flag; and search ends with
// Search in Outlook.

const ALEX = 'google:alex';
const SAM = 'outlook:tenant:sam';
const HOUR = 60 * 60_000;
const NOW = new Date(2026, 9, 7, 15, 0).getTime();
const INBOX = { id: 'AAMk-fld-inbox=', name: 'Inbox', wellKnown: 'inbox' };
const PROJECTS = 'AAMk-fld-projects=';

let store: ItemStore;
let client: EmailClient;
let changes: ItemChanges;
let projects: ProjectsClient;
let close: () => void;
const refreshed: [string, string | undefined][] = [];
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };

const alex: GoogleAccountSummary = {
  id: ALEX,
  source: 'google',
  name: 'Google · alex@gmail.test',
  email: 'alex@gmail.test',
  method: 'oauth',
  status: 'connected',
  user: null,
  sync: null,
  sources: [{ source: 'gmail', granted: true, enabled: true }],
};
const sam: OutlookAccountSummary = {
  id: SAM,
  source: 'outlook',
  name: 'Outlook · sam@contoso.test',
  userPrincipalName: 'sam@contoso.test',
  method: 'oauth',
  status: 'connected',
  user: null,
  sync: null,
  sources: [
    { source: 'outlook', granted: true, enabled: true },
    { source: 'outlook-calendar', granted: true, enabled: true },
  ],
};

const accounts: EmailAccountsClient = {
  list: async () => [alex, sam],
  refresh: async (id, source) => {
    refreshed.push([id, source]);
  },
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
    to: [],
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
    labels: [],
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
  const opened = openTestItemStore();
  ({ store, close, changes } = opened);
  client = emailIn(opened.client);
  projects = projectsIn(opened.client);
  localStorage.clear();
  refreshed.length = 0;
  Element.prototype.scrollIntoView = () => {};
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  store.saveFromSource({
    source: 'gmail',
    account: ALEX,
    items: [mail('receipt', { subject: 'Your order has shipped', labels: [{ id: 'INBOX', name: 'Inbox' }] })],
  });
  store.saveFromSource({
    source: 'outlook',
    account: SAM,
    items: [
      mail('offsite', { subject: 'Q4 offsite dates', sentAt: NOW - 2 * HOUR, folder: INBOX }),
      mail('digest', { subject: 'Weekly digest', sentAt: NOW - 3 * HOUR, folder: INBOX }),
    ],
  });
  store.syncState.saveCatalog(
    SAM,
    'outlook',
    {
      kind: 'outlook',
      folders: [
        { ...INBOX, parentId: null, system: true, synced: true },
        {
          id: 'AAMk-fld-deleted=',
          name: 'Deleted Items',
          wellKnown: 'deleteditems',
          parentId: null,
          system: true,
          synced: false,
        },
        { id: PROJECTS, name: 'Projects', wellKnown: null, parentId: null, system: false, synced: true },
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
const switcher = () => screen.getByRole('tablist', { name: 'Account' });
const views = () => screen.getByRole('tablist', { name: 'View' });

async function loaded() {
  renderSheet();
  await waitFor(() =>
    expect(subjects()).toEqual(['Your order has shipped', 'Q4 offsite dates', 'Weekly digest']),
  );
}

describe('Outlook mail in the Email Section', () => {
  it('lists Outlook threads beside Gmail’s, and the Account switcher narrows to either', async () => {
    await loaded();
    // Opening the Section syncs each Account's mail from its own Source.
    await waitFor(() =>
      expect(refreshed).toEqual([
        [ALEX, 'gmail'],
        [SAM, 'outlook'],
      ]),
    );
    const samTab = within(switcher()).getByRole('tab', { name: 'sam@contoso.test' });
    expect(samTab.textContent).toContain('Outlook');

    fireEvent.click(samTab);
    await waitFor(() => expect(subjects()).toEqual(['Q4 offsite dates', 'Weekly digest']));
    fireEvent.click(within(switcher()).getByRole('tab', { name: 'alex@gmail.test' }));
    await waitFor(() => expect(subjects()).toEqual(['Your order has shipped']));
  });

  it('moves an Outlook thread to a folder with l, listed under that folder’s view, and Undo brings it back', async () => {
    await loaded();
    press('j');

    press('l');
    const picker = await screen.findByRole('dialog', { name: 'Move to folder' });
    // The folders Commander syncs, Outlook's own (Inbox, Deleted Items) aside.
    expect(
      within(picker)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Projects']);
    fireEvent.click(within(picker).getByRole('button', { name: 'Projects' }));

    await waitFor(() => expect(subjects()).toEqual(['Your order has shipped', 'Weekly digest']));
    const toast = await screen.findByText('Moved to Projects: Q4 offsite dates');
    expect(
      store.outgoing
        .list()
        .map((change) => change.field)
        .sort(),
    ).toEqual(['folder', 'inbox']);
    fireEvent.click(within(views()).getByRole('tab', { name: /^Projects/ }));
    await waitFor(() => expect(subjects()).toEqual(['Q4 offsite dates']));

    fireEvent.click(
      within(toast.closest('[data-sonner-toast]') as HTMLElement).getByRole('button', { name: 'Undo' }),
    );
    await waitFor(() => expect(subjects()).toEqual([]));
    expect(store.outgoing.list()).toEqual([]);
  });

  it('calls a star a flag on an Outlook thread', async () => {
    await loaded();
    press('j');
    press('Enter');
    const pane = await screen.findByRole('region', { name: 'Thread' });
    const toolbar = within(pane).getByRole('toolbar', { name: 'Thread actions' });
    expect(within(toolbar).getByRole('button', { name: /^Flag/ })).toBeTruthy();
    expect(within(toolbar).getByRole('button', { name: /^Move to folder/ })).toBeTruthy();
    press('s');
    await screen.findByText('Flagged: Q4 offsite dates');
  });

  it('ends search results with Search in Outlook for the Outlook Account', async () => {
    await loaded();
    press('/');
    const box = screen.getByRole('searchbox', { name: 'Search mail' });
    fireEvent.change(box, { target: { value: 'offsite' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(subjects()).toEqual(['Q4 offsite dates']));
    expect(screen.getByRole('link', { name: /Search in Outlook/ }).getAttribute('href')).toBe(
      'https://outlook.office.com/mail/deeplink/search?query=offsite&login_hint=sam%40contoso.test',
    );
    expect(screen.getByRole('link', { name: /Search in Gmail/ }).getAttribute('href')).toBe(
      'https://mail.google.com/mail/?authuser=alex%40gmail.test#search/offsite',
    );
  });
});
