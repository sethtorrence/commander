// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type {
  ComposeAttachment,
  ComposeDraft,
  ComposeState,
  DraftEntry,
  EmailAddress,
  EmailDetail,
  OutboxEntry,
  ScheduledEntry,
  SourceItem,
} from '@commander/domain';
import type { GoogleAccountSummary } from '@commander/domain/ipc';
import { Toaster } from '@commander/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemChanges } from '../../../item-store/changes';
import { openTestItemStore } from '../../../item-store/test-item-store';
import { ProjectsProvider } from '../../../projects/context';
import { type ProjectsClient, projectsIn } from '../../../projects/projects';
import { ShortcutProvider, ShortcutScope, useActiveScopes } from '../../../shortcuts/react';
import { FrameControlsProvider, SectionProvider } from '../../section';
import { email as definition } from '..';
import { EmailSheet } from '../EmailSheet';
import { type EmailAccountsClient, type EmailClient, emailIn } from '../email';
import { SAVE_PAUSE_MS } from './Composer';
import type { ComposeClient } from './compose';

// Writing email in the Email Section (#138): r, Shift+R, f and c open the composer (a reply below its
// thread, new mail as a sheet), the draft saves after a pause, attachments show their size under the
// 35 MB cap, Send hands the message to the Core with "Sending… Undo", and Undo opens it again as it
// was; the Drafts and Outbox views list what waits. Send later (#139): a time picked beside Send shows
// the running notice for a Gmail Account (not for an Outlook work Account) and Schedule hands it over;
// Scheduled lists what waits, with Edit, Change time, Send now and Cancel. The Core is a stand-in here.

const ALEX = 'google:alex';
const NOW = new Date(2026, 9, 3, 15, 0).getTime();
const dana = { name: 'Dana Whitfield', address: 'dana@northwind.test' };

let store: ItemStore;
let client: EmailClient;
let changes: ItemChanges;
let projects: ProjectsClient;
let close: () => void;
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };

const google = (id: string, address: string): GoogleAccountSummary => ({
  id,
  source: 'google',
  name: `Google · ${address}`,
  email: address,
  method: 'oauth',
  status: 'connected',
  user: null,
  sync: null,
  sources: [{ source: 'gmail', granted: true, enabled: true }],
});

const accountsClient: EmailAccountsClient = {
  list: async () => [google(ALEX, 'alex@gmail.test')],
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
    subject: 'Q4 offsite dates',
    sentAt: NOW - 60 * 60_000,
    snippet: 'Which dates work?',
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
    body: { text: 'Which dates work?', html: null, textFromHtml: false, truncated: false },
  };
}

// The Core, as far as the composer can tell.
function fakeCompose() {
  const calls: { op: string; draft?: ComposeDraft; itemId?: string; sendAt?: number }[] = [];
  let drafts: DraftEntry[] = [];
  let outbox: OutboxEntry[] = [];
  let scheduled: ScheduledEntry[] = [];
  let newAccount = ALEX;
  let attached = 0;
  const base = (fields: Partial<ComposeState>): ComposeState => ({
    itemId: null,
    mode: 'new',
    account: newAccount,
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
  let sent: ComposeState | null = null;
  const compose: ComposeClient = {
    async open(mode, itemId) {
      calls.push({ op: `open:${mode}` });
      if (mode === 'new') return base({});
      return base({
        mode,
        replyToItemId: itemId ?? null,
        to: [dana],
        subject: 'Re: Q4 offsite dates',
        quote:
          'On Sat, 3 Oct 2026 at 14:00, Dana Whitfield <dana@northwind.test> wrote:\n> Which dates work?',
      });
    },
    async openDraft(itemId) {
      calls.push({ op: 'open-draft', itemId });
      return base({ itemId, to: [dana], subject: 'Lunch?' });
    },
    async openSuggested(itemId) {
      calls.push({ op: 'open-suggested', itemId });
      return base({ itemId: 'draft-1', mode: 'reply', replyToItemId: itemId, to: [dana] });
    },
    async save(draft) {
      calls.push({ op: 'save', draft });
      return { itemId: draft.itemId ?? 'draft-1' };
    },
    async send(draft) {
      calls.push({ op: 'send', draft });
      sent = { ...base({}), ...draft, itemId: draft.itemId ?? 'draft-1' };
      return { itemId: draft.itemId ?? 'draft-1', sendAt: Date.now() + 10_000 };
    },
    async undoSend(itemId) {
      calls.push({ op: 'undo-send', itemId });
      return sent as ComposeState;
    },
    async discard(itemId) {
      calls.push({ op: 'discard', itemId });
    },
    async retry(itemId) {
      calls.push({ op: 'retry', itemId });
    },
    async schedule(draft, sendAt) {
      calls.push({ op: 'schedule', draft, sendAt });
      return {
        itemId: draft.itemId ?? 'draft-1',
        sendAt,
        heldBy: draft.account.startsWith('outlook:') ? 'microsoft' : 'commander',
      };
    },
    scheduled: async () => scheduled,
    async reschedule(itemId, sendAt) {
      calls.push({ op: 'reschedule', itemId, sendAt });
    },
    async sendNow(itemId) {
      calls.push({ op: 'send-now', itemId });
    },
    async cancelScheduled(itemId) {
      calls.push({ op: 'cancel-scheduled', itemId });
    },
    async editScheduled(itemId) {
      calls.push({ op: 'edit-scheduled', itemId });
      return base({ itemId, to: [dana], subject: 'Venue options', sendLater: NOW + 26 * 60 * 60_000 });
    },
    drafts: async () => drafts,
    outbox: async () => outbox,
    suggest: async (text: string): Promise<EmailAddress[]> =>
      'dana'.startsWith(text.toLowerCase()) ? [dana] : [],
    async attach(file): Promise<ComposeAttachment> {
      attached += 1;
      return {
        id: `00000000-0000-4000-8000-00000000000${attached}`,
        name: file.name,
        type: file.type,
        size: file.bytes.length,
      };
    },
    settings: async () => ({ defaultAccount: null, undoSeconds: 10 }),
    saveSettings: async (settings) => settings,
    signature: async () => [],
    saveSignature: async (_account, body) => body,
  };
  return {
    compose,
    calls,
    setDrafts: (next: DraftEntry[]) => {
      drafts = next;
    },
    setOutbox: (next: OutboxEntry[]) => {
      outbox = next;
    },
    setScheduled: (next: ScheduledEntry[]) => {
      scheduled = next;
    },
    setNewAccount: (account: string) => {
      newAccount = account;
    },
  };
}

let fake: ReturnType<typeof fakeCompose>;

beforeEach(() => {
  const opened = openTestItemStore();
  ({ store, close, changes } = opened);
  client = emailIn(opened.client);
  projects = projectsIn(opened.client);
  fake = fakeCompose();
  localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  store.saveFromSource({ source: 'gmail', account: ALEX, items: [mail('a')] });
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
                <EmailSheet
                  client={client}
                  accounts={accountsClient}
                  changes={changes}
                  compose={fake.compose}
                />
              </Active>
            </ShortcutScope>
          </SectionProvider>
        </FrameControlsProvider>
      </ProjectsProvider>
      <Toaster />
    </ShortcutProvider>,
  );
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(document.body, { key, ...init });
  });

async function ready() {
  renderSheet();
  await screen.findAllByTestId('email-thread');
}

describe('writing email', () => {
  it('r opens a reply below its thread, from its Account to the sender, with the quote folded', async () => {
    await ready();
    press('r');

    const composer = await screen.findByRole('region', { name: 'Reply' });
    expect(composer.dataset.placement).toBe('inline');
    expect(
      within(screen.getByRole('region', { name: 'Thread' })).getByRole('region', { name: 'Reply' }),
    ).toBe(composer);
    expect(within(composer).getByTestId('compose-from').textContent).toBe('Alex Kim <alex@gmail.test>');
    expect(
      within(composer)
        .getAllByTestId('compose-recipient')
        .map((each) => each.textContent),
    ).toEqual(['Dana Whitfield×']);
    expect(within(composer).getByRole('textbox', { name: 'Subject' })).toHaveProperty(
      'value',
      'Re: Q4 offsite dates',
    );
    expect(within(composer).queryByTestId('compose-quote')).toBeNull();
    fireEvent.click(within(composer).getByRole('button', { name: 'Show quoted text' }));
    expect(within(composer).getByTestId('compose-quote').textContent).toContain('> Which dates work?');
    expect(fake.calls.map((call) => call.op)).toContain('open:reply');
  });

  it('Shift+R replies to all, f forwards, and c starts new mail in a sheet of its own', async () => {
    await ready();
    press('R', { shiftKey: true });
    await waitFor(() => expect(fake.calls.map((call) => call.op)).toContain('open:reply-all'));
    press('Escape');
    press('f');
    await waitFor(() => expect(fake.calls.map((call) => call.op)).toContain('open:forward'));
    press('Escape');
    press('c');
    const sheet = await screen.findByRole('region', { name: 'New message' });
    expect(sheet.dataset.placement).toBe('sheet');
  });

  it('saves the draft after a pause in typing, with what was typed', async () => {
    vi.useFakeTimers({ now: NOW });
    renderSheet();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    press('c');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    const sheet = screen.getByRole('region', { name: 'New message' });
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Subject' }), {
      target: { value: 'Lunch?' },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_PAUSE_MS - 100);
    });
    expect(fake.calls.filter((call) => call.op === 'save')).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(fake.calls.filter((call) => call.op === 'save').map((call) => call.draft?.subject)).toEqual([
      'Lunch?',
    ]);
    expect(within(sheet).getByTestId('compose-saved').textContent).toBe('Draft saved');
  });

  it('suggests addresses from local mail as they are typed', async () => {
    await ready();
    press('c');
    const sheet = await screen.findByRole('region', { name: 'New message' });
    fireEvent.change(within(sheet).getByRole('combobox', { name: 'To' }), { target: { value: 'da' } });
    const option = await within(sheet).findByRole('option', { name: 'Dana Whitfield <dana@northwind.test>' });
    fireEvent.mouseDown(option);
    expect(
      within(sheet)
        .getAllByTestId('compose-recipient')
        .map((each) => each.title),
    ).toEqual(['dana@northwind.test']);
  });

  it('attaches files with their size, refusing more than 35 MB together', async () => {
    await ready();
    press('c');
    const sheet = await screen.findByRole('region', { name: 'New message' });
    const input = within(sheet).getByTestId('compose-attach-input');
    const plan = new File([new Uint8Array(820 * 1024)], 'plan.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [plan] } });
    const row = await within(sheet).findByTestId('compose-attachment');
    expect(row.textContent).toContain('plan.pdf');
    expect(row.textContent).toContain('820 KB');

    const huge = new File([new Uint8Array(1)], 'huge.bin');
    Object.defineProperty(huge, 'size', { value: 35 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [huge] } });
    expect(await within(sheet).findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('Attachments can add up to 35 MB per message'),
    );
    expect(within(sheet).getAllByTestId('compose-attachment')).toHaveLength(1);
  });

  it('sends with “Sending… Undo”, and Undo opens the message again as it was', async () => {
    await ready();
    press('r');
    const composer = await screen.findByRole('region', { name: 'Reply' });
    fireEvent.change(within(composer).getByRole('textbox', { name: 'Subject' }), {
      target: { value: 'Re: dates' },
    });
    fireEvent.click(within(composer).getByRole('button', { name: 'Send' }));

    const toast = await screen.findByText('Sending…');
    expect(screen.queryByRole('region', { name: 'Reply' })).toBeNull();
    const sent = fake.calls.find((call) => call.op === 'send');
    expect(sent?.draft).toMatchObject({ mode: 'reply', subject: 'Re: dates', to: [dana], account: ALEX });
    fireEvent.click(
      within(toast.closest('[data-sonner-toast]') as HTMLElement).getByRole('button', { name: 'Undo' }),
    );

    const again = await screen.findByRole('region', { name: 'Reply' });
    expect(within(again).getByRole('textbox', { name: 'Subject' })).toHaveProperty('value', 'Re: dates');
    expect(fake.calls.map((call) => call.op)).toContain('undo-send');
  });

  it('won’t send to no one', async () => {
    await ready();
    press('c');
    const sheet = await screen.findByRole('region', { name: 'New message' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send' }));
    expect((await within(sheet).findByRole('alert')).textContent).toBe('Add someone to send this to.');
    expect(fake.calls.some((call) => call.op === 'send')).toBe(false);
  });

  it('lists drafts, which open in the composer, and the Outbox, with the reason and Retry', async () => {
    fake.setDrafts([
      {
        itemId: 'd1',
        account: ALEX,
        subject: 'Lunch?',
        to: [dana],
        snippet: 'Are you free',
        updatedAt: NOW,
        commanders: false,
      },
    ]);
    fake.setOutbox([
      {
        itemId: 'o1',
        account: ALEX,
        subject: 'Re: dates',
        to: [dana],
        state: 'failed',
        sendAt: NOW,
        error: 'Gmail refused to send this message: Invalid To header',
        threadKey: 'k',
      },
    ]);
    await ready();

    fireEvent.click(await screen.findByRole('tab', { name: /Drafts/ }));
    fireEvent.click(within(await screen.findByTestId('email-draft')).getByText('Lunch?'));
    expect(await screen.findByRole('region', { name: 'New message' })).toBeTruthy();
    expect(fake.calls).toContainEqual({ op: 'open-draft', itemId: 'd1' });
    press('Escape');

    fireEvent.click(screen.getByRole('tab', { name: /Outbox/ }));
    const entry = await screen.findByTestId('outbox-entry');
    expect(entry.textContent).toContain(
      'Couldn’t send: Gmail refused to send this message: Invalid To header',
    );
    fireEvent.click(within(entry).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fake.calls).toContainEqual({ op: 'retry', itemId: 'o1' }));
  });
});

describe('send later (#139)', () => {
  // Saturday 3 October 2026, 15:00 local: Tomorrow morning is Sunday 08:00.
  const TOMORROW_EIGHT = new Date(2026, 9, 4, 8).getTime();
  const NOTICE = 'Ares has to be running (the window or the tray) at that time to send this.';

  async function newMessage() {
    await ready();
    press('c');
    const sheet = await screen.findByRole('region', { name: 'New message' });
    fireEvent.change(within(sheet).getByRole('combobox', { name: 'To' }), {
      target: { value: 'dana@northwind.test,' },
    });
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Subject' }), {
      target: { value: 'Venue options' },
    });
    return sheet;
  }

  async function pick(sheet: HTMLElement, choice: RegExp) {
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send later' }));
    const picker = await screen.findByTestId('send-later-picker');
    fireEvent.click(within(picker).getByRole('button', { name: choice }));
    await waitFor(() => expect(screen.queryByTestId('send-later-picker')).toBeNull());
  }

  it('on a Gmail Account, the menu and the composer say Ares has to be running, every time a time is picked', async () => {
    const sheet = await newMessage();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send later' }));
    const picker = await screen.findByTestId('send-later-picker');
    expect(
      within(picker)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Tomorrow morning/),
        expect.stringMatching(/^Monday morning/),
      ]),
    );
    expect(within(picker).getByTestId('send-later-notice').textContent).toBe(NOTICE);
    fireEvent.click(within(picker).getByRole('button', { name: /^Tomorrow morning/ }));

    await waitFor(() =>
      expect(within(sheet).getByTestId('compose-send-at').textContent).toBe('tomorrow 08:00'),
    );
    expect(within(sheet).getByTestId('send-later-notice').textContent).toBe(NOTICE);
    // Picked again: said again.
    await pick(sheet, /^Monday morning/);
    expect(within(sheet).getByTestId('send-later-notice').textContent).toBe(NOTICE);
    expect(within(sheet).getByRole('button', { name: 'Schedule' })).toBeTruthy();
  });

  it('Schedule hands it over to go then, closes the composer and says when, with Undo', async () => {
    const sheet = await newMessage();
    await pick(sheet, /^Tomorrow morning/);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Schedule' }));

    await waitFor(() => expect(screen.queryByRole('region', { name: 'New message' })).toBeNull());
    const call = fake.calls.find((each) => each.op === 'schedule');
    expect(call?.sendAt).toBe(TOMORROW_EIGHT);
    expect(call?.draft?.subject).toBe('Venue options');
    expect(fake.calls.map((each) => each.op)).not.toContain('send');
    expect(await screen.findByText('Scheduled for tomorrow 08:00')).toBeTruthy();
  });

  it('× goes back to sending now', async () => {
    const sheet = await newMessage();
    await pick(sheet, /^Tomorrow morning/);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send now instead' }));
    expect(within(sheet).queryByTestId('compose-send-later')).toBeNull();
    expect(within(sheet).getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('on an Outlook work Account there is no running notice: Microsoft holds it', async () => {
    fake.setNewAccount('outlook:3f6a1c2e-0000-4000-8000-00000000c0de:u-alex');
    const sheet = await newMessage();
    await pick(sheet, /^Tomorrow morning/);

    expect(within(sheet).queryByTestId('send-later-notice')).toBeNull();
    expect(within(sheet).getByTestId('send-later-held').textContent).toBe(
      'Microsoft holds it and sends it at that time, even with Commander closed.',
    );
  });

  it('Scheduled lists each message with its time, Account and who holds it, and its actions reach the Core', async () => {
    fake.setScheduled([
      {
        itemId: 'm1',
        account: ALEX,
        subject: 'Venue options',
        to: [dana],
        sendAt: TOMORROW_EIGHT,
        heldBy: 'commander',
        state: 'waiting',
        error: null,
      },
      {
        itemId: 'm2',
        account: ALEX,
        subject: 'Report',
        to: [dana],
        sendAt: NOW - 6 * 60 * 60_000,
        heldBy: 'commander',
        state: 'missed',
        error: null,
      },
    ]);
    await ready();
    const tab = await screen.findByRole('tab', { name: /^Scheduled/ });
    await waitFor(() => expect(tab.textContent).toBe('Scheduled2'));
    fireEvent.click(tab);

    const entries = await screen.findAllByTestId('scheduled-entry');
    expect(entries.map((entry) => within(entry).getByTestId('scheduled-time').textContent)).toEqual([
      'tomorrow 08:00',
      'today 09:00',
    ]);
    expect(within(entries[0] as HTMLElement).getByTestId('scheduled-held-by').textContent).toBe(
      'Sends from Commander',
    );
    expect(entries[0]?.textContent).toContain('alex@gmail.test');
    expect(within(entries[1] as HTMLElement).getByTestId('scheduled-line').textContent).toBe(
      'Missed: it was due today 09:00, while Commander wasn’t running',
    );

    fireEvent.click(within(entries[1] as HTMLElement).getByRole('button', { name: 'Send now' }));
    fireEvent.click(within(entries[0] as HTMLElement).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(entries[0] as HTMLElement).getByRole('button', { name: 'Change time' }));
    const picker = await screen.findByTestId('send-later-picker');
    fireEvent.click(within(picker).getByRole('button', { name: /^Monday morning/ }));
    await waitFor(() =>
      expect(fake.calls.filter((call) => call.itemId).map((call) => `${call.op}:${call.itemId}`)).toEqual([
        'send-now:m2',
        'cancel-scheduled:m1',
        'reschedule:m1',
      ]),
    );
    expect(fake.calls.find((call) => call.op === 'reschedule')?.sendAt).toBe(
      new Date(2026, 9, 5, 8).getTime(),
    );

    fireEvent.click(within(entries[0] as HTMLElement).getByRole('button', { name: 'Edit' }));
    const composer = await screen.findByRole('region', { name: 'New message' });
    // Its time is offered again.
    expect(within(composer).getByTestId('compose-send-at').textContent).toBe('tomorrow 17:00');
  });
});
