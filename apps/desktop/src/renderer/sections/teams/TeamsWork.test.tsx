// @vitest-environment jsdom
import { type Gate, openGate } from '@commander/core/src/autonomy/gate';
import { answerAutonomyRequest } from '@commander/core/src/autonomy/requests';
import type { ItemStore } from '@commander/core/src/item-store';
import { type ChatDraft, type ChatReply, REPLY_IN_TEAMS } from '@commander/domain';
import type { TeamsAccountSummary } from '@commander/domain/ipc';
import { Toaster } from '@commander/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemChanges } from '../../item-store/changes';
import { openTestItemStore } from '../../item-store/test-item-store';
import { ProjectsProvider } from '../../projects/context';
import { type ProjectsClient, projectsIn } from '../../projects/projects';
import { ShortcutProvider, ShortcutScope, useActiveScopes } from '../../shortcuts/react';
import type { AutonomyClient } from '../ares/activity';
import { FrameControlsProvider, SectionProvider } from '../section';
import { teams as definition } from '.';
import { type ChatWorkClient, chatWorkIn } from './chat-work';
import { TeamsSheet } from './TeamsSheet';
import { type TeamsAccountsClient, type TeamsChats, teamsChatsIn } from './teams-chats';
import { chat, HOUR, message, NOW, PRIYA, SAM, TEAMS } from './test-chats';

// Ares's work in the Chat view (#110), against a real Item store and gate on a temporary database:
// a suggested Todo beside its message (Add, Dismiss), a suggested reply above the reply box (Send,
// Edit, Dismiss), and Draft, with a stand-in for the Core's Draft Skill. Nothing is sent to Teams
// without the User pressing Send.

const SUGGEST_TODOS = 'suggest-todos';
const DRAFTED = 'Yes, I’ll have the rollout plan to you by Friday.';

let store: ItemStore;
let gate: Gate;
let chats: TeamsChats;
let projects: ProjectsClient;
let changes: ItemChanges;
let work: ChatWorkClient;
let close: () => void;
let aresListeners: Set<() => void>;
let drafted: string[];
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };

const accounts: TeamsAccountsClient = {
  list: async () => [
    {
      id: TEAMS,
      source: 'teams',
      name: 'Teams · sam@contoso.test',
      userPrincipalName: 'sam@contoso.test',
      method: 'oauth',
      status: 'connected',
      user: { id: SAM.userId ?? '', name: SAM.name },
      sync: null,
    } satisfies TeamsAccountSummary,
  ],
  syncNow: async () => {},
  onChange: () => () => {},
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  const opened = openTestItemStore(() => NOW);
  ({ store, close, changes } = opened);
  chats = teamsChatsIn(opened.client);
  projects = projectsIn(opened.client);
  aresListeners = new Set();
  drafted = [];
  // What the gate changed reaches open views too, as the Core tells the window.
  const fromStore = changes;
  const fromGate = new Set<(itemIds: string[]) => void>();
  changes = (listener) => {
    const stop = fromStore(listener);
    fromGate.add(listener);
    return () => {
      stop();
      fromGate.delete(listener);
    };
  };
  gate = openGate({
    itemStore: store,
    onChange: (itemIds, suggestionsOn) =>
      queueMicrotask(() => {
        for (const listener of aresListeners) listener();
        for (const listener of fromGate) listener([...itemIds, ...suggestionsOn]);
      }),
  });
  gate.registerAction({ action: SUGGEST_TODOS, actionKind: 'organise', name: 'Suggest Todos' });
  gate.registerAction({ action: REPLY_IN_TEAMS, actionKind: 'act-for-you', name: 'Reply in Teams' });
  gate.setLevel({ scope: 'section', section: 'teams', actionKind: 'organise' }, 'ask');
  let id = 0;
  const autonomy: AutonomyClient = async (request) => {
    id += 1;
    const reply = answerAutonomyRequest(
      gate,
      { type: 'autonomy-request', id, request },
      { testHooks: false },
    );
    if (!reply?.response.ok)
      throw new Error(reply?.response.ok === false ? reply.response.error : 'No reply');
    // biome-ignore lint/suspicious/noExplicitAny: unchecked here, as the main process would check it
    return reply.response.result as any;
  };
  work = {
    ...chatWorkIn({
      autonomy,
      updates: (async (request: { op: string; itemId: string }) => {
        drafted.push(request.itemId);
        return { itemId: request.itemId, text: DRAFTED, at: NOW } satisfies ChatDraft;
      }) as never,
    }),
    onAresChange(listener) {
      aresListeners.add(listener);
      return () => aresListeners.delete(listener);
    },
  };
  localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
  store.saveFromSource({
    source: 'teams',
    account: TEAMS,
    items: [
      chat({
        id: '19:priya_sam@unq.gbl.spaces',
        title: 'Priya Patel',
        messages: [
          message(PRIYA, 'Morning!', 3 * HOUR),
          message(PRIYA, 'Can you send me the rollout plan by Friday?', 2 * HOUR),
        ],
      }),
    ],
  });
});

afterEach(() => {
  cleanup();
  close();
  vi.useRealTimers();
});

const priya = () => store.query({ kinds: ['chat'] })[0]?.id as string;
// The replies on their way to Teams (opening the Chat also marks it read, which isn't one).
const queued = () => store.outgoing.forItem(priya()).filter((row) => row.field.startsWith('message:'));
const lastReplyEntry = () =>
  store.activity({ itemId: priya() }).find((entry) => JSON.stringify(entry.changes).includes('replies'));
const asked = () => {
  const detail = store.get(priya())?.item.detail;
  return detail?.kind === 'chat' ? (detail.messages[1]?.id as string) : '';
};

function suggestTodo() {
  return gate.propose({
    action: SUGGEST_TODOS,
    actionKind: 'organise',
    section: 'teams',
    itemId: priya(),
    itemActions: [
      {
        type: 'create',
        item: {
          kind: 'todo',
          title: 'Send Priya the rollout plan',
          detail: {
            kind: 'todo',
            origin: 'ares',
            dueOn: '2026-10-09',
            backedBy: null,
            fromMessage: { itemId: priya(), messageId: asked() },
          },
        },
      },
      { type: 'link', from: { step: 0 }, linkType: 'made-from', to: priya() },
    ],
    confidence: 0.95,
    reason: 'Priya Patel asked in Teams: “Can you send me the rollout plan by Friday?”',
    causedBy: { itemId: priya() },
  });
}

const REPLY: ChatReply = {
  clientId: 'ares-1',
  text: 'Hi Priya, I’ll send the rollout plan by Friday.',
  createdAt: NOW,
};
function suggestReply() {
  return gate.propose({
    action: REPLY_IN_TEAMS,
    actionKind: 'act-for-you',
    section: 'teams',
    itemId: priya(),
    itemActions: [{ type: 'edit-fields', itemId: priya(), fields: { [`message:${REPLY.clientId}`]: REPLY } }],
    confidence: 1,
    reason: 'Priya asked you for the rollout plan by Friday',
    causedBy: { itemId: priya() },
  });
}

function Active({ children }: { children: ReactNode }) {
  useActiveScopes(['teams']);
  return children;
}

function renderSheet(withWork = true) {
  return render(
    <ShortcutProvider>
      <ProjectsProvider client={projects} storage={localStorage}>
        <FrameControlsProvider value={controls}>
          <SectionProvider place={{ definition, number: 8, total: 9, active: true }}>
            <ShortcutScope scope="teams" group="Teams">
              <Active>
                <TeamsSheet
                  chats={chats}
                  accounts={accounts}
                  changes={changes}
                  work={withWork ? work : undefined}
                />
                <Toaster />
              </Active>
            </ShortcutScope>
          </SectionProvider>
        </FrameControlsProvider>
      </ProjectsProvider>
    </ShortcutProvider>,
  );
}

const view = () => screen.getByRole('region', { name: 'Chat' });
const box = () => within(view()).getByRole('textbox', { name: 'Reply' }) as HTMLTextAreaElement;

async function openPriya(withWork = true) {
  renderSheet(withWork);
  await waitFor(() => expect(screen.getAllByTestId('teams-chat')).toHaveLength(1));
  fireEvent.click(screen.getByRole('listitem', { name: 'Priya Patel' }));
  await waitFor(() => expect(within(view()).getByRole('heading', { name: 'Priya Patel' })).toBeTruthy());
}

const messageNamed = (text: string) =>
  within(view())
    .getAllByTestId('chat-message')
    .find((each) => each.textContent?.includes(text)) as HTMLElement;

describe('a suggested Todo in the Chat view', () => {
  it('shows beside the message it came from; Add creates the Todo', async () => {
    suggestTodo();
    await openPriya();
    const card = await within(messageNamed('rollout plan')).findByRole('group', {
      name: 'Suggested Todo: Send Priya the rollout plan',
    });
    expect(card.textContent).toContain('due Fri 9 Oct');
    expect(within(messageNamed('Morning!')).queryByTestId('chat-todo-suggestion')).toBeNull();

    fireEvent.click(within(card).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(within(view()).queryByTestId('chat-todo-suggestion')).toBeNull());
    const [todo] = store.query({ kinds: ['todo'] });
    expect(todo).toMatchObject({ title: 'Send Priya the rollout plan' });
    expect(todo?.detail).toMatchObject({
      origin: 'ares',
      fromMessage: { itemId: priya(), messageId: asked() },
    });
    expect(await screen.findByText('Todo added: Send Priya the rollout plan')).toBeTruthy();
  });

  it('Dismiss drops it', async () => {
    const outcome = suggestTodo();
    await openPriya();
    const card = await within(view()).findByTestId('chat-todo-suggestion');
    fireEvent.click(within(card).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(within(view()).queryByTestId('chat-todo-suggestion')).toBeNull());
    const id = outcome.decision === 'ask' ? outcome.suggestion.id : 0;
    expect(store.autonomy.proposal(id)?.status).toBe('dismissed');
    expect(store.query({ kinds: ['todo'] })).toEqual([]);
  });
});

describe('a suggested reply above the reply box', () => {
  it('shows the full draft; Send sends it as the User’s reply through the queue', async () => {
    suggestReply();
    await openPriya();
    const card = await within(view()).findByRole('region', { name: 'Suggested reply' });
    expect(within(card).getByTestId('chat-reply-draft').textContent).toBe(REPLY.text);
    expect(within(card).getByTestId('chat-reply-reason').textContent).toBe(
      'Priya asked you for the rollout plan by Friday',
    );
    // Nothing is on its way until the User presses Send.
    expect(queued()).toEqual([]);

    fireEvent.click(within(card).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(within(view()).queryByRole('region', { name: 'Suggested reply' })).toBeNull());
    expect(queued().map((row) => [row.field, row.status])).toEqual([
      [`message:${REPLY.clientId}`, 'pending'],
    ]);
    expect(lastReplyEntry()).toMatchObject({
      by: { kind: 'user' },
      why: 'Priya asked you for the rollout plan by Friday',
    });
    await waitFor(() =>
      expect(within(view()).getByRole('region', { name: 'On its way to Teams' }).textContent).toContain(
        REPLY.text,
      ),
    );
  });

  it('Edit moves the draft into the reply box, for the User to change and send', async () => {
    const outcome = suggestReply();
    await openPriya();
    const card = await within(view()).findByRole('region', { name: 'Suggested reply' });
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(box().value).toBe(REPLY.text));
    await waitFor(() => expect(within(view()).queryByRole('region', { name: 'Suggested reply' })).toBeNull());
    const id = outcome.decision === 'ask' ? outcome.suggestion.id : 0;
    expect(store.autonomy.proposal(id)?.status).toBe('dismissed');
    expect(queued()).toEqual([]);

    fireEvent.change(box(), { target: { value: `${REPLY.text} Thanks!` } });
    fireEvent.click(within(view()).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(queued()).toHaveLength(1));
    const [row] = queued();
    expect((row?.value as ChatReply | undefined)?.text).toBe(`${REPLY.text} Thanks!`);
  });

  it('Dismiss drops it, sending nothing', async () => {
    suggestReply();
    await openPriya();
    const card = await within(view()).findByRole('region', { name: 'Suggested reply' });
    fireEvent.click(within(card).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(within(view()).queryByRole('region', { name: 'Suggested reply' })).toBeNull());
    expect(queued()).toEqual([]);
    expect(box().value).toBe('');
  });
});

describe('Draft', () => {
  it('fills the reply box with Ares’s draft, which the User sends as any reply', async () => {
    await openPriya();
    fireEvent.click(within(view()).getByRole('button', { name: 'Draft' }));
    await waitFor(() => expect(box().value).toBe(DRAFTED));
    expect(drafted).toEqual([priya()]);
    // Nothing went anywhere by itself.
    expect(queued()).toEqual([]);

    fireEvent.click(within(view()).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(queued()).toHaveLength(1));
    expect((queued()[0]?.value as ChatReply | undefined)?.text).toBe(DRAFTED);
    expect(lastReplyEntry()?.by).toEqual({ kind: 'user' });
  });

  it('replaces what was typed, which Undo brings back', async () => {
    await openPriya();
    fireEvent.change(box(), { target: { value: 'Half a thought' } });
    fireEvent.click(within(view()).getByRole('button', { name: 'Draft' }));
    await waitFor(() => expect(box().value).toBe(DRAFTED));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(box().value).toBe('Half a thought'));
  });

  it('isn’t offered without Ares', async () => {
    await openPriya(false);
    expect(within(view()).queryByRole('button', { name: 'Draft' })).toBeNull();
  });
});
