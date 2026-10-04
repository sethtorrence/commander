// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { ChatSummary, SummaryRange } from '@commander/domain';
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
import { FrameControlsProvider, SectionProvider } from '../section';
import { teams as definition } from '.';
import type { ChatSummariser } from './chat-summary';
import { TeamsSheet } from './TeamsSheet';
import { type TeamsAccountsClient, type TeamsChats, teamsChatsIn } from './teams-chats';
import { chat, HOUR, LEE, message, NOW, PRIYA, SAM, TEAMS } from './test-chats';

// Ares in the Teams Section (#109), against a real Item store on a temporary database: the Waiting
// on you filter and mark, "Not waiting" (a correction, undone), and Summarise in the Chat view with
// a stand-in for the Core's Summarise Skill. What Ares wrote is shown through AresText.

let store: ItemStore;
let chats: TeamsChats;
let projects: ProjectsClient;
let changes: ItemChanges;
let close: () => void;
let asked: { itemId: string; range: SummaryRange }[];
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };
const REASON = 'Priya asked whether you can sign off the launch today';

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

const SUMMARIES: Record<SummaryRange, string> = {
  'since-read':
    'Priya wants your sign-off on the launch; notes at https://contoso.test/launch and https://evil.test.',
  today: 'Today Priya asked for your sign-off.',
  week: 'Launch moved to Thursday, and Priya wants your sign-off.',
};

let summariser: ChatSummariser;
const recorded: ChatSummariser = {
  async summarise(itemId, range): Promise<ChatSummary> {
    asked.push({ itemId, range });
    return {
      itemId,
      range,
      text: SUMMARIES[range],
      count: range === 'week' ? 3 : 2,
      at: NOW,
      sources: [
        'Launch moved to Thursday. Notes: https://contoso.test/launch',
        '@Sam Rivera can you sign off?',
      ],
    };
  },
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  const opened = openTestItemStore();
  ({ store, close, changes } = opened);
  chats = teamsChatsIn(opened.client);
  projects = projectsIn(opened.client);
  asked = [];
  summariser = { ...recorded };
  localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
  store.saveFromSource({
    source: 'teams',
    account: TEAMS,
    items: [
      chat({
        id: '19:launch@thread.v2',
        title: 'Launch crew',
        chatType: 'group',
        lastReadAt: NOW - 4 * HOUR,
        messages: [
          message(LEE, 'Launch moved to Thursday. Notes: https://contoso.test/launch', 26 * HOUR),
          message(PRIYA, '@Sam Rivera can you sign off?', 3 * HOUR, { mentions: [SAM] }),
        ],
      }),
      chat({
        id: '19:social@thread.v2',
        title: 'Social',
        chatType: 'group',
        messages: [message(LEE, 'Lunch?', HOUR)],
      }),
      chat({
        id: '19:priya_sam@unq.gbl.spaces',
        title: 'Priya Patel',
        messages: [message(PRIYA, 'Thanks!', 2 * HOUR)],
      }),
    ],
  });
  const launch = chatId('Launch crew');
  const detail = store.get(launch)?.item.detail;
  const ask = detail?.kind === 'chat' ? (detail.messages[1]?.id as string) : '';
  store.chatWaiting.flag(launch, { messageId: ask, reason: REASON }, NOW);
});

afterEach(() => {
  cleanup();
  close();
  vi.useRealTimers();
});

function chatId(title: string) {
  return store.query({ kinds: ['chat'] }).find((item) => item.title === title)?.id ?? '';
}

function Active({ children }: { children: ReactNode }) {
  useActiveScopes(['teams']);
  return children;
}

function renderSheet() {
  return render(
    <ShortcutProvider>
      <ProjectsProvider client={projects} storage={localStorage}>
        <FrameControlsProvider value={controls}>
          <SectionProvider place={{ definition, number: 8, total: 9, active: true }}>
            <ShortcutScope scope="teams" group="Teams">
              <Active>
                <TeamsSheet chats={chats} accounts={accounts} changes={changes} summariser={summariser} />
                <Toaster />
              </Active>
            </ShortcutScope>
          </SectionProvider>
        </FrameControlsProvider>
      </ProjectsProvider>
    </ShortcutProvider>,
  );
}

const listed = () => screen.queryAllByTestId('teams-chat').map((row) => row.getAttribute('aria-label'));
const waitingOnly = () => screen.getByRole('switch', { name: /Waiting on you/ });
const view = () => screen.getByRole('region', { name: 'Chat' });

async function openLaunch() {
  renderSheet();
  await waitFor(() => expect(listed()).toContain('Launch crew'));
  fireEvent.click(screen.getByRole('listitem', { name: 'Launch crew' }));
  await waitFor(() => expect(within(view()).getByRole('heading', { name: 'Launch crew' })).toBeTruthy());
}

describe('waiting on you in the Teams Section', () => {
  it('marks the Chats Ares flagged and filters to them', async () => {
    renderSheet();
    await waitFor(() => expect(listed()).toHaveLength(3));
    const launch = screen.getByRole('listitem', { name: 'Launch crew' });
    expect(within(launch).getByLabelText('Ares: someone here is waiting on you')).toBeTruthy();
    expect(within(screen.getByRole('listitem', { name: 'Social' })).queryByText('Waiting')).toBeNull();
    expect(waitingOnly().textContent).toMatch(/01$/);

    fireEvent.click(waitingOnly());
    await waitFor(() => expect(listed()).toEqual(['Launch crew']));
    expect(waitingOnly().getAttribute('aria-checked')).toBe('true');
  });

  it('shows Ares’s reason in the Chat view; Not waiting clears it as a correction, and Undo brings it back', async () => {
    await openLaunch();
    const note = within(view()).getByRole('region', { name: 'Waiting on you' });
    expect(within(note).getByTestId('chat-waiting-reason').textContent).toBe(REASON);

    fireEvent.click(within(note).getByRole('button', { name: 'Not waiting' }));
    await waitFor(() => expect(within(view()).queryByRole('region', { name: 'Waiting on you' })).toBeNull());
    expect(store.get(chatId('Launch crew'))?.item.waiting).toBeUndefined();
    const [correction] = store.activity({ itemId: chatId('Launch crew') });
    expect(correction).toMatchObject({
      action: 'correction',
      by: { kind: 'user' },
      why: 'Not waiting on you',
    });
    await waitFor(() => expect(within(view()).getByText('Marked not waiting on you by you')).toBeTruthy());

    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(within(view()).getByRole('region', { name: 'Waiting on you' })).toBeTruthy());
    expect(store.get(chatId('Launch crew'))?.item.waiting?.reason).toBe(REASON);
    await waitFor(() => expect(within(view()).getByText('Not waiting undone by you')).toBeTruthy());
  });
});

describe('Summarise in the Chat view', () => {
  it('summarises since the User last read it, then today and this week, through AresText', async () => {
    await openLaunch();
    fireEvent.click(within(view()).getByRole('button', { name: 'Summarise' }));
    const panel = await within(view()).findByRole('region', { name: 'Summary' });
    await waitFor(() =>
      expect(within(panel).getByTestId('chat-summary-text').textContent).toContain(
        'Priya wants your sign-off',
      ),
    );
    expect(asked).toEqual([{ itemId: chatId('Launch crew'), range: 'since-read' }]);
    expect(
      within(panel).getByRole('button', { name: 'Since I last read' }).getAttribute('aria-pressed'),
    ).toBe('true');
    // AresText: a link only to what the Chat's messages hold.
    const links = within(panel).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['https://contoso.test/launch']);
    expect(within(panel).getByTestId('chat-summary-text').textContent).toContain('https://evil.test');

    fireEvent.click(within(panel).getByRole('button', { name: 'Today' }));
    await waitFor(() =>
      expect(within(panel).getByTestId('chat-summary-text').textContent).toContain(
        'Today Priya asked for your sign-off.',
      ),
    );
    fireEvent.click(within(panel).getByRole('button', { name: 'This week' }));
    await waitFor(() =>
      expect(within(panel).getByTestId('chat-summary-text').textContent).toContain('3 messages'),
    );
    expect(asked.map((each) => each.range)).toEqual(['since-read', 'today', 'week']);

    // Back to one already made: shown again, not asked for again.
    fireEvent.click(within(panel).getByRole('button', { name: 'Today' }));
    await waitFor(() =>
      expect(within(panel).getByTestId('chat-summary-text').textContent).toContain('Today Priya asked'),
    );
    expect(asked).toHaveLength(3);
  });

  it('says why when Ares couldn’t summarise it', async () => {
    summariser.summarise = vi.fn(async () => {
      throw new Error('Ares couldn’t summarise it: his reply didn’t make sense');
    });
    await openLaunch();
    fireEvent.click(within(view()).getByRole('button', { name: 'Summarise' }));
    await waitFor(() =>
      expect(within(view()).getByTestId('chat-summary-text').textContent).toBe(
        'Ares couldn’t summarise it: his reply didn’t make sense',
      ),
    );
  });
});
