// @vitest-environment jsdom
import { type Gate, openGate } from '@commander/core/src/autonomy/gate';
import { answerAutonomyRequest } from '@commander/core/src/autonomy/requests';
import type { ItemStore } from '@commander/core/src/item-store';
import { type EmailDetail, SORT_INTO_BUCKETS, type SourceItem } from '@commander/domain';
import type { GoogleAccountSummary } from '@commander/domain/ipc';
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

// Ares's sorting in the Email Section (#141), against a real Item store and gate: his suggested Bucket
// on a thread's row and in the open thread, with Confirm and Change; his progress beside the sync
// status; and the one-time question before a Gmail Account's mail goes to a cloud model.

const ALEX = 'google:alex';
const HOUR = 60 * 60_000;
const NOW = new Date(2026, 9, 7, 15, 0).getTime();

let store: ItemStore;
let gate: Gate;
let client: EmailClient;
let changes: ItemChanges;
let projects: ProjectsClient;
let close: () => void;
let cloudMail: Record<string, 'allowed' | 'declined'>;
let jobsRun: string[];
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

function mail(id: string, subject: string, sentAt: number): SourceItem {
  const detail: EmailDetail = {
    kind: 'email',
    messageId: `<${id}@mail.test>`,
    inReplyTo: null,
    references: [],
    threadKey: `mid:<${id}@mail.test>`,
    sourceThreadId: id,
    from: { name: 'Shop', address: 'orders@shop.test' },
    to: [{ name: 'Alex Kim', address: 'alex@gmail.test' }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject,
    sentAt,
    snippet: `About ${subject}`,
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
const bucketOf = (externalId: string) =>
  (store.get(idOf(externalId))?.item.detail as EmailDetail | undefined)?.bucket ?? null;

// Ares, unsure: his suggested Bucket waits on the email.
function suggest(externalId: string, bucketId: string) {
  const itemId = idOf(externalId);
  gate.propose({
    action: SORT_INTO_BUCKETS,
    actionKind: 'organise',
    section: 'email',
    itemId,
    itemActions: [{ type: 'edit-fields', itemId, fields: { bucket: { bucketId, sortedBy: 'ares' } } }],
    confidence: 0.6,
    reason: 'Looks like an order',
  });
}

beforeEach(() => {
  const opened = openTestItemStore(() => NOW);
  ({ store, close, changes } = opened);
  gate = openGate({ itemStore: store });
  gate.registerAction({ action: SORT_INTO_BUCKETS, actionKind: 'organise', name: 'Sort into Buckets' });
  cloudMail = { [ALEX]: 'allowed' };
  jobsRun = [];
  let id = 0;
  const autonomy = (async (request: unknown) => {
    id += 1;
    const reply = answerAutonomyRequest(
      gate,
      { type: 'autonomy-request', id, request },
      {
        testHooks: false,
        jobs: {
          jobs: () => [],
          status: () => ({ working: false, running: [] }),
          setEnabled: () => [],
          run: (job: string) => void jobsRun.push(job),
        },
      },
    );
    if (!reply?.response.ok)
      throw new Error(reply?.response.ok === false ? reply.response.error : 'No reply');
    return reply.response.result;
  }) as unknown as Window['commander']['autonomy'];
  // Settings → Ares, as the Core keeps it: in the Item store.
  const models = (async (request: { op: string; account?: string; answer?: 'allowed' | 'declined' }) => {
    if (request.op === 'set-cloud-mail' && request.account && request.answer)
      cloudMail = { ...cloudMail, [request.account]: request.answer };
    store.models.saveSettings({ ...store.models.settings(), cloudMail });
    return { ok: true, result: store.models.settings() };
  }) as unknown as Window['commander']['models'];
  store.models.saveSettings({ ...store.models.settings(), cloudMail });
  client = emailIn(opened.client, { autonomy: () => autonomy, models: () => models });
  projects = projectsIn(opened.client);
  localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  store.saveFromSource({
    source: 'gmail',
    account: ALEX,
    items: [
      mail('order', 'Your order has shipped', NOW - HOUR),
      mail('refund', 'Your refund is on its way', NOW - 2 * HOUR),
      mail('other', 'Something else', NOW - 3 * HOUR),
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

const rowOf = (subject: string) =>
  screen
    .getAllByTestId('email-thread')
    .find((row) => within(row).getByTestId('thread-subject').textContent === subject) as HTMLElement;

describe('Ares’s sorting in the Email Section', () => {
  it('shows his suggested Bucket on the row; Confirm sorts it there, by the User', async () => {
    suggest('order', 'receipts');
    renderSheet();
    const row = await waitFor(() => rowOf('Your order has shipped'));
    expect(within(row).getByRole('img', { name: 'Ares suggests Receipts' })).toBeTruthy();

    fireEvent.click(within(row).getByRole('button', { name: 'Confirm Receipts' }));
    await waitFor(() => expect(bucketOf('order')).toEqual({ bucketId: 'receipts', sortedBy: 'user' }));
    await waitFor(() =>
      expect(rowOf('Your order has shipped').querySelector('[data-slot="bucket"]')?.textContent).toBe(
        'Receipts',
      ),
    );
    expect(store.emailSorting.feedback()[0]).toMatchObject({ kind: 'confirmation', suggested: 'receipts' });
    await screen.findByText('Moved to Receipts: Your order has shipped');
  });

  it('Change opens the Bucket picker; another Bucket is a correction', async () => {
    suggest('refund', 'receipts');
    renderSheet();
    const row = await waitFor(() => rowOf('Your refund is on its way'));
    fireEvent.click(within(row).getByRole('button', { name: 'Change the Bucket' }));
    const picker = await screen.findByRole('dialog', { name: 'Move to a Bucket' });
    fireEvent.click(within(picker).getByRole('option', { name: /FYI/ }));
    await waitFor(() => expect(bucketOf('refund')).toEqual({ bucketId: 'fyi', sortedBy: 'user' }));
    expect(store.emailSorting.feedback()[0]).toMatchObject({
      kind: 'correction',
      suggested: 'receipts',
      chosen: 'fyi',
    });
  });

  it('shows his suggestion in the open thread too', async () => {
    suggest('order', 'receipts');
    renderSheet();
    fireEvent.click(await waitFor(() => rowOf('Your order has shipped')));
    const suggested = await screen.findByTestId('suggested-bucket');
    fireEvent.click(within(suggested).getByRole('button', { name: 'Confirm Receipts' }));
    await waitFor(() => expect(bucketOf('order')).toEqual({ bucketId: 'receipts', sortedBy: 'user' }));
  });

  it('shows how far he has got beside the sync status', async () => {
    suggest('order', 'receipts');
    renderSheet();
    await waitFor(() =>
      expect(screen.getByTestId('email-sorting-status').textContent).toBe('Ares is sorting: 1 of 3'),
    );
  });

  it('asks once before a Gmail Account’s mail goes to a cloud model, and starts sorting when allowed', async () => {
    cloudMail = {};
    renderSheet();
    const question = await screen.findByRole('region', { name: 'Ares and alex@gmail.test' });
    expect(question.textContent).toContain('Let Ares read mail from alex@gmail.test?');
    expect(question.textContent).toContain('Z.ai');
    await act(async () => {
      fireEvent.click(within(question).getByRole('button', { name: 'Allow' }));
    });
    await waitFor(() => expect(screen.queryByTestId('cloud-mail-question')).toBeNull());
    expect(cloudMail).toEqual({ [ALEX]: 'allowed' });
    expect(jobsRun).toContain(SORT_INTO_BUCKETS);
  });

  it('Don’t allow keeps Ares away and asks no more', async () => {
    cloudMail = {};
    renderSheet();
    const question = await screen.findByRole('region', { name: 'Ares and alex@gmail.test' });
    fireEvent.click(within(question).getByRole('button', { name: 'Don’t allow' }));
    await waitFor(() => expect(screen.queryByTestId('cloud-mail-question')).toBeNull());
    expect(cloudMail).toEqual({ [ALEX]: 'declined' });
    expect(jobsRun).toEqual([]);
  });
});
