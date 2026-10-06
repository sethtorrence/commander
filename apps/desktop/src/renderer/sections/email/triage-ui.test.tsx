// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type {
  ComposeState,
  EmailAddress,
  EmailDetail,
  OutboxEntry,
  Project,
  SourceItem,
} from '@commander/domain';
import type { GoogleAccountSummary } from '@commander/domain/ipc';
import { Toaster } from '@commander/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemChanges } from '../../item-store/changes';
import type { ItemStoreClient } from '../../item-store/client';
import { openTestItemStore } from '../../item-store/test-item-store';
import { CommandProvider, type CommandRegistry, createCommandRegistry } from '../../palette/commands';
import { ProjectsProvider } from '../../projects/context';
import { saveFilter } from '../../projects/filter';
import { type ProjectsClient, projectsIn } from '../../projects/projects';
import { ShortcutProvider, ShortcutScope, useActiveScopes, useShortcutList } from '../../shortcuts/react';
import { FrameControlsProvider, SectionProvider } from '../section';
import { originLabel } from '../todos/origin';
import { todosIn } from '../todos/todos';
import { email as definition } from '.';
import type { ComposeClient } from './compose/compose';
import { EmailSheet } from './EmailSheet';
import { type EmailAccountsClient, type EmailClient, emailIn } from './email';
import { ACCOUNT_STORAGE_KEY } from './use-email';

// Triage (#140) in the Email Section, against a real Item store (the composer's Core is a stand-in):
// started from the Bucket strip, Shift+T or the palette, it walks one Bucket one thread at a time,
// narrowed by the Account switcher and the Project filter; each key acts and moves on, Undo goes back
// to the thread, keys never fire while typing; the end sums up and offers the next Bucket with mail.
// And Make it a Todo, from the Email Section too.

const ALEX = 'google:alex';
const SAM = 'google:sam';
const HOUR = 60 * 60_000;
// Wednesday 7 October 2026, 15:00.
const NOW = new Date(2026, 9, 7, 15, 0).getTime();
const dana = { name: 'Dana Reyes', address: 'dana@northwind.test' };

let store: ItemStore;
let itemStore: ItemStoreClient;
let client: EmailClient;
let changes: ItemChanges;
let projects: ProjectsClient;
let close: () => void;
let commands: CommandRegistry;
let lt: Project;
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
    from: dana,
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
    status: 'open',
    detail,
    body: { text: `Body of ${id}`, html: null, textFromHtml: false, truncated: false },
  };
}

const emailId = (externalId: string) =>
  store.query({ kinds: ['email'] }).find((item) => item.externalId === externalId)?.id ?? '';
const detailOf = (externalId: string) => store.get(emailId(externalId))?.item.detail as EmailDetail;
const sortInto = (externalId: string, bucketId: string) =>
  store.record(
    { type: 'edit-fields', itemId: emailId(externalId), fields: { bucket: { bucketId, sortedBy: 'user' } } },
    { by: { kind: 'user' } },
  );

// The Core, as far as the composer can tell: a reply to Dana, held for Undo.
function fakeCompose() {
  const calls: string[] = [];
  let outbox: OutboxEntry[] = [];
  let sent: ComposeState | null = null;
  const base = (fields: Partial<ComposeState>): ComposeState => ({
    itemId: null,
    mode: 'new',
    account: ALEX,
    replyToItemId: null,
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    body: [{ type: 'paragraph', runs: [] }],
    attachments: [],
    from: { name: 'Alex Kim', address: 'alex@gmail.test' },
    quote: null,
    ...fields,
  });
  const compose: ComposeClient = {
    async open(mode, itemId) {
      calls.push(`open:${mode}`);
      return base({ mode, replyToItemId: itemId ?? null, to: [dana], subject: 'Re: Q4 offsite dates' });
    },
    openDraft: async (itemId) => base({ itemId }),
    openSuggested: async (itemId) => base({ mode: 'reply', replyToItemId: itemId }),
    save: async (draft) => ({ itemId: draft.itemId ?? 'draft-1' }),
    async send(draft) {
      calls.push('send');
      sent = { ...base({}), ...draft, itemId: 'draft-1' };
      outbox = [
        {
          itemId: 'draft-1',
          account: ALEX,
          subject: draft.subject,
          to: draft.to,
          state: 'held',
          sendAt: Date.now() + 10_000,
          error: null,
        } as OutboxEntry,
      ];
      return { itemId: 'draft-1', sendAt: Date.now() + 10_000 };
    },
    async undoSend() {
      calls.push('undo-send');
      outbox = [];
      return sent as ComposeState;
    },
    discard: async () => {},
    retry: async () => {},
    drafts: async () => [],
    outbox: async () => outbox,
    suggest: async (): Promise<EmailAddress[]> => [],
    attach: async () => {
      throw new Error('not here');
    },
    settings: async () => ({ defaultAccount: null, undoSeconds: 10 }),
    saveSettings: async (settings) => settings,
    signature: async () => [],
    saveSignature: async (_account, body) => body,
  };
  return { compose, calls };
}

let fake: ReturnType<typeof fakeCompose>;

beforeEach(() => {
  const opened = openTestItemStore(() => NOW);
  ({ store, close, changes } = opened);
  itemStore = opened.client;
  client = emailIn(opened.client);
  projects = projectsIn(opened.client);
  commands = createCommandRegistry();
  fake = fakeCompose();
  localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  lt = store.changeProject({ type: 'create', project: { name: 'Longtail', code: 'LT', accent: 'blue' } })
    .project as Project;
  store.saveFromSource({
    source: 'gmail',
    account: ALEX,
    items: [
      mail('offsite', { subject: 'Q4 offsite dates', sentAt: NOW - HOUR }),
      mail('contract', { subject: 'Signed contract?', sentAt: NOW - 2 * HOUR }),
      mail('cert', { subject: 'Staging certificate', sentAt: NOW - 3 * HOUR }),
      mail('lunch', { subject: 'Lunch on Friday?', sentAt: NOW - 4 * HOUR }),
      mail('quote', { subject: 'Your quote', sentAt: NOW - 5 * HOUR }),
      mail('news', { subject: 'Weekly digest', sentAt: NOW - 6 * HOUR }),
    ],
  });
  store.saveFromSource({
    source: 'gmail',
    account: SAM,
    items: [mail('standup', { subject: 'Standup notes', sentAt: NOW - 30 * 60_000 })],
  });
  for (const each of ['offsite', 'contract', 'cert', 'lunch', 'standup']) sortInto(each, 'needs-reply');
  sortInto('quote', 'waiting-on-others');
  // Weekly digest stays Unsorted. The offsite is Longtail's.
  store.record(
    {
      type: 'update',
      itemId: emailId('offsite'),
      changes: { filing: { projectId: lt.id, filedBy: 'user' } },
    },
    { by: { kind: 'user' } },
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
        <li
          key={`${each.scope}:${each.keys.join('+')}`}
        >{`${each.group}: ${each.keys.join('+')} ${each.label}`}</li>
      ))}
    </ul>
  );
}

function renderSheet() {
  return render(
    <ShortcutProvider>
      <CommandProvider registry={commands}>
        <ProjectsProvider client={projects} storage={localStorage}>
          <FrameControlsProvider value={controls}>
            <SectionProvider place={{ definition, number: 5, total: 8, active: true }}>
              <ShortcutScope scope="email" group="Email">
                <Active>
                  <EmailSheet client={client} accounts={accounts} changes={changes} compose={fake.compose} />
                </Active>
              </ShortcutScope>
            </SectionProvider>
          </FrameControlsProvider>
          <KeyList />
          <Toaster />
        </ProjectsProvider>
      </CommandProvider>
    </ShortcutProvider>,
  );
}

const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) =>
  act(() => {
    fireEvent.keyDown(target, { key, ...init });
  });

const position = () => screen.getByTestId('triage-position').textContent;
const shownSubject = () =>
  within(screen.getByRole('region', { name: 'Thread' })).getByRole('heading').textContent;
// The newest toast saying it (toasts are listed newest first).
const toastSaying = async (text: string) =>
  (await screen.findAllByText(text))[0]?.closest('[data-sonner-toast]') as HTMLElement;
const snoozeTomorrow = async () =>
  fireEvent.click(
    within(await screen.findByRole('dialog', { name: 'Snooze until' })).getByRole('button', {
      name: /^Tomorrow morning/,
    }),
  );

async function loaded() {
  renderSheet();
  await waitFor(() => expect(screen.getAllByTestId('email-thread')).toHaveLength(7));
}

async function triageNeedsReply() {
  await loaded();
  fireEvent.click(screen.getByRole('button', { name: /^Triage Needs reply/ }));
  await waitFor(() => expect(position()).toBe('Needs reply · 1 of 5'));
}

describe('Triage', () => {
  it('walks Needs reply one thread at a time, full width, with the Badge, the Bucket and the keys', async () => {
    await triageNeedsReply();

    expect(shownSubject()).toBe('Standup notes');
    expect(screen.queryAllByTestId('email-thread')).toHaveLength(0);
    expect(screen.queryByRole('tablist', { name: 'Bucket' })).toBeNull();
    const header = screen.getByTestId('triage-header');
    expect(within(header).getByText('Needs reply')).toBeTruthy();
    expect(within(header).getByLabelText(/Unfiled/)).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Triage keys' }))
        .getAllByRole('listitem')
        .map((each) => each.textContent),
    ).toEqual([
      'R Reply',
      '⇧R Reply all',
      'E Archive',
      'Z Snooze',
      'T Todo',
      'V Bucket',
      'B Project',
      'JSpace Skip',
      'K Back',
      'CtrlZ Undo',
      'Esc Leave',
    ]);
    // Every key is in the `?` cheat sheet, under Triage.
    const listed = screen.getByTestId('key-list').textContent ?? '';
    for (const key of [
      'Triage: R Reply, then on',
      'Triage: Shift+R Reply all, then on',
      'Triage: E Archive',
      'Triage: Z Snooze',
      'Triage: T Make it a Todo',
      'Triage: V Move to another Bucket',
      'Triage: B Set its Project',
      'Triage: J Skip',
      'Triage:   Skip',
      'Triage: K Back to the previous thread',
      'Triage: Ctrl+Z Undo the last decision',
      'Triage: Escape Leave Triage',
    ])
      expect(listed).toContain(key);

    press('j');
    await waitFor(() => expect(position()).toBe('Needs reply · 2 of 5'));
    expect(shownSubject()).toBe('Q4 offsite dates');
    expect(within(screen.getByTestId('triage-header')).getByLabelText(/Longtail/)).toBeTruthy();
    press(' ');
    await waitFor(() => expect(position()).toBe('Needs reply · 3 of 5'));
    press('k');
    await waitFor(() => expect(position()).toBe('Needs reply · 2 of 5'));
  });

  it('e archives and moves on at once; Undo (Ctrl+Z or the toast) reverts it and returns to the thread', async () => {
    await triageNeedsReply();
    press('j');
    await waitFor(() => expect(shownSubject()).toBe('Q4 offsite dates'));

    press('e');
    await waitFor(() => expect(position()).toBe('Needs reply · 3 of 5'));
    expect(shownSubject()).toBe('Signed contract?');
    expect(detailOf('offsite').inInbox).toBe(false);
    await toastSaying('Archived: Q4 offsite dates');

    press('z', { ctrlKey: true });
    await waitFor(() => expect(position()).toBe('Needs reply · 2 of 5'));
    expect(shownSubject()).toBe('Q4 offsite dates');
    await waitFor(() => expect(detailOf('offsite').inInbox).toBe(true));

    press('e');
    await waitFor(() => expect(position()).toBe('Needs reply · 3 of 5'));
    const toast = await toastSaying('Archived: Q4 offsite dates');
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(position()).toBe('Needs reply · 2 of 5'));
    await waitFor(() => expect(detailOf('offsite').inInbox).toBe(true));
  });

  it('z snoozes with the snooze picker, v moves to another Bucket as the User, b sets the Project', async () => {
    await triageNeedsReply();

    press('z');
    await snoozeTomorrow();
    await waitFor(() => expect(position()).toBe('Needs reply · 2 of 5'));
    expect(store.get(emailId('standup'))?.item.detail).toMatchObject({ snooze: { returned: false } });

    press('v');
    const picker = await screen.findByRole('dialog', { name: 'Move to a Bucket' });
    fireEvent.click(within(picker).getByRole('option', { name: /FYI/ }));
    await waitFor(() => expect(position()).toBe('Needs reply · 3 of 5'));
    expect(detailOf('offsite').bucket).toEqual({ bucketId: 'fyi', sortedBy: 'user' });
    await toastSaying('Moved to FYI: Q4 offsite dates');

    press('b');
    const badges = await screen.findByRole('listbox', { name: 'Projects' });
    fireEvent.click(within(badges).getByRole('option', { name: /Longtail/ }));
    await waitFor(() => expect(position()).toBe('Needs reply · 4 of 5'));
    expect(store.get(emailId('contract'))?.item.filing).toEqual({ projectId: lt.id, filedBy: 'user' });
  });

  it('t makes a Todo with a made-from Link and the email’s Project, titled as edited; typing never fires keys', async () => {
    await triageNeedsReply();
    press('j');
    await waitFor(() => expect(shownSubject()).toBe('Q4 offsite dates'));

    press('t');
    const dialog = await screen.findByRole('dialog', { name: 'Make it a Todo' });
    const title = within(dialog).getByRole('textbox', { name: 'Title' }) as HTMLInputElement;
    expect(title.value).toBe('Q4 offsite dates');
    expect(dialog.textContent).toContain('From email · Dana Reyes');
    // Keys typed in the title are typing: nothing is archived, nothing skipped.
    press('e', {}, title);
    press('j', {}, title);
    fireEvent.change(title, { target: { value: 'Pick the offsite dates' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Add Todo/ }));

    await waitFor(() => expect(position()).toBe('Needs reply · 3 of 5'));
    expect(detailOf('offsite').inInbox).toBe(true);
    await toastSaying('Todo added: Pick the offsite dates');
    const [todo] = store.query({ kinds: ['todo'] });
    expect(todo).toMatchObject({
      title: 'Pick the offsite dates',
      filing: { projectId: lt.id, filedBy: 'inherited' },
      detail: { origin: 'email' },
    });
    const view = store.get(todo?.id ?? '');
    expect(view?.links.map((link) => [link.type, link.to.id])).toEqual([['made-from', emailId('offsite')]]);

    // In the Todos Section: "From email · Dana Reyes".
    const todos = todosIn(itemStore);
    const madeFrom = await todos.madeFrom(await todos.list());
    expect(originLabel(todo as NonNullable<typeof todo>, madeFrom.get(todo?.id ?? ''))).toBe(
      'From email · Dana Reyes',
    );

    // Undo takes the Todo away and goes back to the thread.
    press('z', { ctrlKey: true });
    await waitFor(() => expect(position()).toBe('Needs reply · 2 of 5'));
    await waitFor(() => expect(store.query({ kinds: ['todo'] })).toEqual([]));
  });

  it('r replies in place; once sent Triage moves on, and Undo takes the reply back in its thread', async () => {
    await triageNeedsReply();
    press('j');
    await waitFor(() => expect(shownSubject()).toBe('Q4 offsite dates'));

    press('r');
    const composer = await screen.findByRole('region', { name: 'Reply' });
    expect(composer.dataset.placement).toBe('inline');
    // While composing, Triage's keys wait: typing goes to the composer, and e from outside it is not Archive.
    press('e');
    expect(position()).toBe('Needs reply · 2 of 5');
    fireEvent.click(within(composer).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(position()).toBe('Needs reply · 3 of 5'));
    expect(fake.calls).toContain('send');
    const toast = await toastSaying('Sending…');
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(position()).toBe('Needs reply · 2 of 5'));
    expect(fake.calls).toContain('undo-send');
    expect((await screen.findByRole('region', { name: 'Reply' })).dataset.placement).toBe('inline');
  });

  it('closing the reply moves on without counting it', async () => {
    await triageNeedsReply();
    press('r');
    const composer = await screen.findByRole('region', { name: 'Reply' });
    fireEvent.click(within(composer).getByRole('button', { name: /^Close/ }));
    await waitFor(() => expect(position()).toBe('Needs reply · 2 of 5'));
  });

  it('ends with an accurate summary and the next Bucket with mail; Enter starts it, Esc leaves to where the User was', async () => {
    await triageNeedsReply();

    press('e'); // Standup notes
    await waitFor(() => expect(position()).toBe('Needs reply · 2 of 5'));
    press('z');
    await snoozeTomorrow();
    await waitFor(() => expect(position()).toBe('Needs reply · 3 of 5'));
    press('t');
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Make it a Todo' })).getByRole('button', {
        name: /Add Todo/,
      }),
    );
    await waitFor(() => expect(position()).toBe('Needs reply · 4 of 5'));
    press('v');
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Move to a Bucket' })).getByRole('option', {
        name: /FYI/,
      }),
    );
    await waitFor(() => expect(position()).toBe('Needs reply · 5 of 5'));
    press('j');

    const end = await screen.findByRole('region', { name: 'Triage done' });
    expect(within(end).getByRole('heading').textContent).toBe('Needs reply done');
    expect(screen.getByTestId('triage-summary').textContent).toBe(
      '4 done: 1 archived, 1 snoozed, 1 Todo, 1 moved',
    );
    expect(end.textContent).toContain('1 skipped');
    // Waiting on others comes next in the User's order (FYI now has the thread just moved, but comes after).
    const next = await within(end).findByRole('button', { name: /^Next: Waiting on others \(1\)/ });
    expect(next).toBeTruthy();

    press('Enter');
    await waitFor(() => expect(position()).toBe('Waiting on others · 1 of 1'));
    expect(shownSubject()).toBe('Your quote');
    press('e');
    const after = await screen.findByRole('region', { name: 'Triage done' });
    expect(await within(after).findByRole('button', { name: /^Next: FYI \(1\)/ })).toBeTruthy();

    press('Escape');
    await waitFor(() => expect(screen.queryByTestId('triage')).toBeNull());
    expect(
      within(screen.getByRole('tablist', { name: 'Bucket' }))
        .getByRole('tab', { name: /^All/ })
        .getAttribute('aria-selected'),
    ).toBe('true');
    await waitFor(() => expect(screen.getAllByTestId('email-thread').length).toBeGreaterThan(0));
  });

  it('is narrowed by the Account switcher and the Project filter', async () => {
    await loaded();
    fireEvent.click(screen.getByRole('tab', { name: 'sam@work.test' }));
    await waitFor(() => expect(screen.getAllByTestId('email-thread')).toHaveLength(1));
    press('T', { shiftKey: true });
    await waitFor(() => expect(position()).toBe('Needs reply · 1 of 1'));
    expect(shownSubject()).toBe('Standup notes');
    press('Escape');
    cleanup();

    localStorage.removeItem(ACCOUNT_STORAGE_KEY);
    saveFilter(localStorage, lt.id);
    renderSheet();
    await waitFor(() => expect(screen.getAllByTestId('email-thread')).toHaveLength(1));
    press('T', { shiftKey: true });
    await waitFor(() => expect(position()).toBe('Needs reply · 1 of 1'));
    expect(shownSubject()).toBe('Q4 offsite dates');
  });

  it('starts from the palette (Triage <Bucket>) or Shift+T on the chosen Bucket, and says when one is empty', async () => {
    await loaded();
    const labels = commands.list().map((each) => each.label);
    expect(labels.filter((label) => label.startsWith('Triage '))).toEqual([
      'Triage Needs reply',
      'Triage Waiting on others',
      'Triage FYI',
      'Triage Newsletters',
      'Triage Receipts',
      'Triage Calendar',
      'Triage Junk',
    ]);
    act(() =>
      commands
        .list()
        .find((each) => each.label === 'Triage Waiting on others')
        ?.run(),
    );
    await waitFor(() => expect(position()).toBe('Waiting on others · 1 of 1'));
    expect(controls.openSection).toHaveBeenCalledWith('email');
    press('Escape');

    fireEvent.click(
      within(await screen.findByRole('tablist', { name: 'Bucket' })).getByRole('tab', { name: /^Receipts/ }),
    );
    expect(screen.getByRole('button', { name: /^Triage Receipts/ })).toBeTruthy();
    press('T', { shiftKey: true });
    const end = await screen.findByRole('region', { name: 'Triage done' });
    expect(within(end).getByRole('heading').textContent).toBe('Nothing to triage in Receipts');
    expect(screen.queryByTestId('triage-summary')).toBeNull();
    expect(within(end).getByText('No other Bucket has mail waiting.')).toBeTruthy();
  });
});

describe('Make it a Todo in the Email Section', () => {
  it('t on the selected thread, or the open thread’s Todo button, makes it, with Undo', async () => {
    await loaded();
    press('j');
    press('t');
    const dialog = await screen.findByRole('dialog', { name: 'Make it a Todo' });
    expect((within(dialog).getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe(
      'Q4 offsite dates',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: /Add Todo/ }));
    await toastSaying('Todo added: Q4 offsite dates');
    expect(store.query({ kinds: ['todo'] })).toHaveLength(1);
    press('z', { ctrlKey: true });
    await waitFor(() => expect(store.query({ kinds: ['todo'] })).toEqual([]));

    press('Enter');
    const reader = await screen.findByRole('region', { name: 'Thread' });
    fireEvent.click(within(reader).getByRole('button', { name: /^Todo/ }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Make it a Todo' })).getByRole('button', {
        name: /Add Todo/,
      }),
    );
    await waitFor(() => expect(store.query({ kinds: ['todo'] })).toHaveLength(1));
  });
});
