// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import {
  type ComposeDraft,
  type ComposeState,
  type EmailDetail,
  NEEDS_REPLY,
  type ReadyReply,
  type SourceItem,
} from '@commander/domain';
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
import { type ComposeClient, noCompose } from './compose/compose';
import { EmailSheet } from './EmailSheet';
import { type EmailAccountsClient, type EmailClient, emailIn } from './email';

// Ares's suggested reply in the Email Section (#143): offered at the end of a Needs reply thread (Draft
// a reply, with what to say), ready (his draft through AresText, unsure or not, Open in composer, Draft
// again, Dismiss), `d` to ask from the list; and in the composer, a link he added held back until the
// User keeps it. The Core is the test Item store, with Ares and the composer stood in for.

const ALEX = 'google:alex';
const NOW = new Date(2026, 9, 3, 15, 0).getTime();
const dana = { name: 'Dana Whitfield', address: 'dana@northwind.test' };
const DRAFT = 'Hi Dana,\n\nThursday works for me.\n\nCheers,\nAlex';
const LINK = 'https://cal.example/alex';

let store: ItemStore;
let client: EmailClient;
let changes: ItemChanges;
let projects: ProjectsClient;
let close: () => void;
let compose: ComposeClient;
let composeCalls: { op: string; itemId?: string; draft?: ComposeDraft }[];
let drafted: { itemId: string; instruction?: string }[];
let message: string;
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

function mail(id: string): SourceItem {
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

function suggest(fields: Partial<{ body: string; addedLinks: string[]; confidence: number }> = {}) {
  return store.suggestedReplies.save({
    account: ALEX,
    threadKey: 'mid:<a@mail.test>',
    answering: message,
    body: DRAFT,
    addedLinks: [],
    confidence: 0.9,
    ...fields,
  });
}

beforeEach(() => {
  const opened = openTestItemStore();
  ({ store, close, changes } = opened);
  drafted = [];
  composeCalls = [];
  // Ares, on request: drafts and keeps it, as the Core does.
  client = {
    ...emailIn(opened.client),
    async draftReply(itemId, instruction) {
      drafted.push({ itemId, ...(instruction ? { instruction } : {}) });
      return suggest({ body: 'Hi Dana,\n\nYes, Thursday.\n\nAlex' }) as ReadyReply;
    },
  };
  // The composer's Core: the suggested reply opens as a reply holding his draft and the link he added.
  compose = {
    ...noCompose,
    async openSuggested(itemId) {
      composeCalls.push({ op: 'open-suggested', itemId });
      const state: ComposeState = {
        itemId: 'draft-1',
        mode: 'reply',
        account: ALEX,
        replyToItemId: itemId,
        to: [dana],
        cc: [],
        bcc: [],
        subject: 'Re: Q4 offsite dates',
        body: [
          { type: 'paragraph', runs: [{ text: 'Slots: ' }, { text: LINK, aresLink: true }] },
          { type: 'paragraph', runs: [{ text: 'Alex' }] },
        ],
        attachments: [],
        from: { name: 'Alex Kim', address: 'alex@gmail.test' },
        quote: null,
      };
      return state;
    },
    async save(draft) {
      composeCalls.push({ op: 'save', draft });
      return { itemId: 'draft-1' };
    },
    async send(draft) {
      composeCalls.push({ op: 'send', draft });
      return { itemId: 'draft-1', sendAt: Date.now() + 10_000 };
    },
  };
  projects = projectsIn(opened.client);
  localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  store.saveFromSource({ source: 'gmail', account: ALEX, items: [mail('a')] });
  message = store.query({ kinds: ['email'] })[0]?.id as string;
  // Ares may read this Account's mail.
  store.models.saveSettings({ ...store.models.settings(), cloudMail: { [ALEX]: 'allowed' } });
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
                <EmailSheet client={client} accounts={accountsClient} changes={changes} compose={compose} />
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

async function openThread() {
  renderSheet();
  fireEvent.click(await screen.findByTestId('email-thread'));
  return screen.findByRole('region', { name: 'Thread' });
}

function needsReply() {
  store.recordAll(
    [
      {
        type: 'edit-fields',
        itemId: message,
        fields: { bucket: { bucketId: NEEDS_REPLY, sortedBy: 'user' } },
      },
    ],
    { by: { kind: 'user' } },
  );
}

describe('Ares’s suggested reply', () => {
  it('waits at the end of the thread; Open in composer makes it a draft below the thread', async () => {
    suggest();
    const thread = await openThread();
    const card = await within(thread).findByRole('region', { name: 'Suggested reply' });
    expect(card.dataset.state).toBe('ready');
    expect(within(card).getByTestId('suggested-reply-body').textContent).toContain('Thursday works for me.');
    expect(card.textContent).toContain('Sent only when you press Send');
    expect(within(card).queryByTestId('suggested-reply-unsure')).toBeNull();

    fireEvent.click(within(card).getByRole('button', { name: 'Open in composer' }));
    const composer = await within(thread).findByRole('region', { name: 'Reply' });
    expect(composeCalls).toContainEqual({ op: 'open-suggested', itemId: message });
    expect(composer.dataset.placement).toBe('inline');
  });

  it('holds back a link Ares added until the User keeps it', async () => {
    suggest({ body: `Slots: ${LINK}\nAlex`, addedLinks: [LINK] });
    const thread = await openThread();
    const card = await within(thread).findByRole('region', { name: 'Suggested reply' });
    expect(within(card).getByTestId('suggested-reply-links').textContent).toContain(LINK);
    fireEvent.click(within(card).getByRole('button', { name: 'Open in composer' }));
    const composer = await within(thread).findByRole('region', { name: 'Reply' });

    // Marked in the body, listed with Keep and Remove; Send asks the User to decide first.
    expect(within(composer).getByTestId('compose-body').querySelector('[data-ares-link]')?.textContent).toBe(
      LINK,
    );
    const links = within(composer).getByRole('list', { name: 'Links Ares added' });
    expect(links.textContent).toContain('Ares added this link');
    fireEvent.click(within(composer).getByRole('button', { name: 'Send' }));
    expect((await within(composer).findByRole('alert')).textContent).toBe(
      'Keep or remove the link Ares added first: it isn’t sent unless you keep it.',
    );
    expect(composeCalls.some((call) => call.op === 'send')).toBe(false);

    fireEvent.click(within(composer).getByRole('button', { name: `Keep ${LINK}` }));
    expect(within(composer).queryByRole('list', { name: 'Links Ares added' })).toBeNull();
    fireEvent.click(within(composer).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(composeCalls.some((call) => call.op === 'send')).toBe(true));
    const sent = composeCalls.find((call) => call.op === 'send')?.draft;
    expect(sent?.body[0]).toEqual({ type: 'paragraph', runs: [{ text: 'Slots: ' }, { text: LINK }] });
  });

  it('says when Ares isn’t sure', async () => {
    suggest({ confidence: 0.4 });
    const thread = await openThread();
    const card = await within(thread).findByRole('region', { name: 'Suggested reply' });
    expect(within(card).getByTestId('suggested-reply-unsure').textContent).toContain('isn’t sure');
  });

  it('is offered on a Needs reply thread, and drafted when asked, with what to say', async () => {
    needsReply();
    const thread = await openThread();
    const card = await within(thread).findByRole('region', { name: 'Suggested reply' });
    expect(card.dataset.state).toBe('offered');
    fireEvent.change(within(card).getByRole('textbox', { name: 'What the reply should say (optional)' }), {
      target: { value: 'Say yes, Thursday' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Draft a reply' }));

    await waitFor(() =>
      expect(within(thread).getByRole('region', { name: 'Suggested reply' }).dataset.state).toBe('ready'),
    );
    expect(drafted).toEqual([{ itemId: message, instruction: 'Say yes, Thursday' }]);
    expect(within(thread).getByTestId('suggested-reply-body').textContent).toContain('Yes, Thursday.');
  });

  it('d drafts one for the selected thread, wherever it is', async () => {
    renderSheet();
    await screen.findByTestId('email-thread');
    press('d');
    const thread = await screen.findByRole('region', { name: 'Thread' });
    await waitFor(() =>
      expect(within(thread).getByRole('region', { name: 'Suggested reply' }).dataset.state).toBe('ready'),
    );
    expect(drafted).toEqual([{ itemId: message }]);
  });

  it('Dismiss takes it away from the thread', async () => {
    needsReply();
    suggest();
    const thread = await openThread();
    const card = await within(thread).findByRole('region', { name: 'Suggested reply' });
    fireEvent.click(within(card).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(within(thread).queryByRole('region', { name: 'Suggested reply' })).toBeNull());
    expect(store.emailThread(ALEX, 'mid:<a@mail.test>')?.suggestedReply).toBeNull();
  });
});
