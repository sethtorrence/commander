// @vitest-environment jsdom
import { type Gate, openGate } from '@commander/core/src/autonomy/gate';
import { answerAutonomyRequest } from '@commander/core/src/autonomy/requests';
import type { ItemStore } from '@commander/core/src/item-store';
import { setUpSkipInbox } from '@commander/core/src/skip-inbox';
import { type EmailDetail, SKIP_THE_INBOX, type SourceItem } from '@commander/domain';
import type { GoogleAccountSummary } from '@commander/domain/ipc';
import { Toaster } from '@commander/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemChanges } from '../../item-store/changes';
import { openTestItemStore } from '../../item-store/test-item-store';
import { ProjectsProvider } from '../../projects/context';
import { projectsIn } from '../../projects/projects';
import { ShortcutProvider, ShortcutScope, useActiveScopes } from '../../shortcuts/react';
import type { AutonomyClient } from '../ares/activity';
import { FrameControlsProvider, SectionProvider } from '../section';
import { email as definition } from '.';
import { EmailSheet } from './EmailSheet';
import { type EmailAccountsClient, type EmailClient, emailIn } from './email';

// Skip the inbox in the Email Section (#142), against a real Item store and gate: a Rule's sort into a
// Bucket that skips the inbox shows as a suggestion on the email (Archive, or Not now) and grouped in
// the Bucket view ("Archive 2 Newsletters?") with Accept all, which archives them, undoably.

const ALEX = 'google:alex';
const NOW = new Date(2026, 9, 7, 15, 0).getTime();

let store: ItemStore;
let gate: Gate;
let client: EmailClient;
let autonomy: AutonomyClient;
let changes: ItemChanges;
let close: () => void;
let itemStoreClient: ReturnType<typeof openTestItemStore>['client'];
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

function mail(id: string, subject: string, from: string): SourceItem {
  const detail: EmailDetail = {
    kind: 'email',
    messageId: `<${id}@mail.test>`,
    inReplyTo: null,
    references: [],
    threadKey: `mid:<${id}@mail.test>`,
    sourceThreadId: id,
    from: { name: 'Sender', address: from },
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject,
    sentAt: NOW - 3_600_000,
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
  };
  return { externalId: id, kind: 'email', title: subject, status: 'open', detail };
}

const idOf = (externalId: string) =>
  store.query({ kinds: ['email'] }).find((item) => item.externalId === externalId)?.id ?? '';
const inInbox = (externalId: string) =>
  (store.get(idOf(externalId))?.item.detail as EmailDetail | undefined)?.inInbox;

beforeEach(() => {
  const opened = openTestItemStore();
  ({ store, close, changes } = opened);
  itemStoreClient = opened.client;
  client = emailIn(opened.client);
  gate = openGate({ itemStore: store });
  const skip = setUpSkipInbox({ store, gate, log: () => {} });
  let id = 0;
  autonomy = async (request) => {
    id += 1;
    const reply = answerAutonomyRequest(
      gate,
      { type: 'autonomy-request', id, request },
      { testHooks: false },
    );
    if (!reply?.response.ok)
      throw new Error(reply?.response.ok === false ? reply.response.error : 'No reply');
    // biome-ignore lint/suspicious/noExplicitAny: the Core's reply is unchecked here, as the main process would check it
    return reply.response.result as any;
  };
  localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });

  store.changeBucket({ type: 'update', bucketId: 'newsletters', bucket: { skipInbox: true } });
  store.changeRule({
    type: 'create',
    rule: {
      target: { kind: 'bucket', bucketId: 'newsletters' },
      when: {
        join: 'and',
        terms: [{ field: 'gmail.domain', op: 'is', value: 'digest.test', label: 'digest.test' }],
      },
    },
  });
  store.saveFromSource({
    source: 'gmail',
    account: ALEX,
    items: [
      mail('n1', 'Weekly digest', 'news@digest.test'),
      mail('n2', 'Product update', 'hello@digest.test'),
      mail('p1', 'Staging certificate', 'priya@contoso.test'),
    ],
    deleted: [],
  });
  skip.consider([idOf('n1'), idOf('n2'), idOf('p1')]);
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
      <ProjectsProvider client={projectsIn(itemStoreClient)} storage={localStorage}>
        <FrameControlsProvider value={controls}>
          <SectionProvider place={{ definition, number: 5, total: 8, active: true }}>
            <ShortcutScope scope="email" group="Email">
              <Active>
                <EmailSheet client={client} accounts={accounts} changes={changes} autonomy={autonomy} />
              </Active>
            </ShortcutScope>
          </SectionProvider>
        </FrameControlsProvider>
        <Toaster />
      </ProjectsProvider>
    </ShortcutProvider>,
  );
}

const rows = () => screen.queryAllByTestId('email-thread');
const strip = () => screen.getByRole('tablist', { name: 'Bucket' });

describe('Skip the inbox in the Email Section', () => {
  it('groups the suggestions in the Bucket view, and Accept all archives them; Undo brings them back', async () => {
    renderSheet();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(within(strip()).getByRole('tab', { name: /^Newsletters/ }));

    const offer = await screen.findByRole('region', { name: 'Skip the inbox' });
    expect(offer.textContent).toContain('Archive 2 Newsletters?');
    fireEvent.click(within(offer).getByRole('button', { name: 'Accept all' }));

    await waitFor(() => expect(inInbox('n1')).toBe(false));
    expect(inInbox('n2')).toBe(false);
    expect(inInbox('p1')).toBe(true);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Skip the inbox' })).toBeNull());

    const toast = await screen.findByText('Archived 2 Newsletters');
    fireEvent.click(
      within(toast.closest('[data-sonner-toast]') as HTMLElement).getByRole('button', { name: 'Undo' }),
    );
    await waitFor(() => expect(inInbox('n1')).toBe(true));
    expect(inInbox('n2')).toBe(true);
  });

  it('shows the suggestion on the email, with Archive and Not now', async () => {
    renderSheet();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const row = rows().find((each) => each.textContent?.includes('Weekly digest')) as HTMLElement;
    expect(within(row).getByText('Archive?')).toBeTruthy();
    fireEvent.click(row);

    const suggestion = await screen.findByRole('region', { name: 'Ares’s suggestion' });
    expect(suggestion.textContent).toContain('Newsletters skips the inbox');
    fireEvent.click(within(suggestion).getByRole('button', { name: 'Not now' }));
    await waitFor(() =>
      expect(gate.activity({ action: SKIP_THE_INBOX, statuses: ['dismissed'] })).toHaveLength(1),
    );
    expect(inInbox('n1')).toBe(true);

    const other = rows().find((each) => each.textContent?.includes('Product update')) as HTMLElement;
    fireEvent.click(other);
    const next = await screen.findByRole('region', { name: 'Ares’s suggestion' });
    fireEvent.click(within(next).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(inInbox('n2')).toBe(false));
  });
});
