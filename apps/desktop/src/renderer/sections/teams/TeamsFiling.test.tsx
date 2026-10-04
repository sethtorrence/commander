// @vitest-environment jsdom
import { createFiling } from '@commander/core/src/agent/filing';
import { type Gate, openGate } from '@commander/core/src/autonomy/gate';
import { answerAutonomyRequest } from '@commander/core/src/autonomy/requests';
import type { ItemStore } from '@commander/core/src/item-store';
import { FILE_INTO_PROJECTS, type Project } from '@commander/domain';
import type { TeamsAccountSummary } from '@commander/domain/ipc';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { TeamsSheet } from './TeamsSheet';
import { type TeamsAccountsClient, type TeamsChats, teamsChatsIn } from './teams-chats';
import { chat, HOUR, message, NOW, PRIYA, SAM, TEAMS } from './test-chats';

// Ares's filing on Chats in the Teams Section (#108): a Chat he wasn't sure about wears his dashed
// Badge on its row and in the Chat view, where Confirm and Change answer it; each answer is recorded
// and shows in the Chat's activity. A real Item store and gate on a temporary database.

let store: ItemStore;
let gate: Gate;
let chats: TeamsChats;
let projects: ProjectsClient;
let changes: ItemChanges;
let close: () => void;
let tl: Project;
let tx: Project;
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };

const account: TeamsAccountSummary = {
  id: TEAMS,
  source: 'teams',
  name: 'Teams · sam@contoso.test',
  userPrincipalName: 'sam@contoso.test',
  method: 'oauth',
  status: 'connected',
  user: { id: SAM.userId ?? '', name: SAM.name },
  sync: null,
};
const accounts: TeamsAccountsClient = {
  list: async () => [account],
  syncNow: async () => {},
  onChange: () => () => {},
};

const chatId = (title: string) =>
  store.query({ kinds: ['chat'] }).find((item) => item.title === title)?.id ?? '';

// Ares, unsure, suggests Titanlink for a Chat.
function suggest(title: string) {
  const itemId = chatId(title);
  gate.propose({
    actionKind: 'organise',
    action: FILE_INTO_PROJECTS,
    section: 'teams',
    itemId,
    itemActions: [{ type: 'update', itemId, changes: { filing: { projectId: tl.id, filedBy: 'ares' } } }],
    confidence: 0.55,
    reason: 'Omar works on Titanlink',
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  const opened = openTestItemStore();
  ({ store, close, changes } = opened);
  gate = openGate({ itemStore: store });
  gate.registerAction({ action: FILE_INTO_PROJECTS, actionKind: 'organise', name: 'File into Projects' });
  const filing = createFiling({ itemStore: store, gate });
  let id = 0;
  const autonomy: AutonomyClient = async (request) => {
    id += 1;
    const reply = answerAutonomyRequest(
      gate,
      { type: 'autonomy-request', id, request },
      { testHooks: false, filing },
    );
    if (!reply?.response.ok)
      throw new Error(reply?.response.ok === false ? reply.response.error : 'No reply');
    // biome-ignore lint/suspicious/noExplicitAny: the Core's reply is unchecked here, as the main process would check it
    return reply.response.result as any;
  };
  chats = teamsChatsIn(opened.client);
  projects = projectsIn(opened.client, () => autonomy as never);
  localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
  const project = (name: string, code: string) =>
    store.changeProject({ type: 'create', project: { name, code, accent: 'teal' } }).project as Project;
  tl = project('Titanlink', 'TL');
  tx = project('Tactics', 'TX');
  store.saveFromSource({
    source: 'teams',
    account: TEAMS,
    items: [
      chat({ id: '19:relay', title: 'Relay rollout', messages: [message(PRIYA, 'Relay is slow', HOUR)] }),
      chat({
        id: '19:pager',
        title: 'Pager talk',
        messages: [message(PRIYA, 'Who has the pager?', 2 * HOUR)],
      }),
    ],
  });
  suggest('Relay rollout');
  suggest('Pager talk');
});

afterEach(() => {
  cleanup();
  close();
  vi.useRealTimers();
});

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
                <TeamsSheet chats={chats} accounts={accounts} changes={changes} />
              </Active>
            </ShortcutScope>
          </SectionProvider>
        </FrameControlsProvider>
      </ProjectsProvider>
    </ShortcutProvider>,
  );
}

const row = (title: string) =>
  screen
    .getAllByTestId('teams-chat')
    .find((each) => each.getAttribute('aria-label') === title) as HTMLElement;
const view = () => screen.getByRole('region', { name: 'Chat' });

describe('Ares’s filing on Chats', () => {
  it('shows the dashed Badge on the Chat row and in the Chat view, where Confirm files it by the User', async () => {
    renderSheet();
    await waitFor(() =>
      expect(within(row('Relay rollout')).getByRole('img', { name: 'Ares suggests Titanlink' })).toBeTruthy(),
    );
    expect(within(row('Pager talk')).getByRole('img', { name: 'Ares suggests Titanlink' })).toBeTruthy();

    fireEvent.click(row('Relay rollout'));
    const suggested = await within(view()).findByTestId('suggested-filing');
    expect(within(suggested).getByRole('img', { name: 'Ares suggests Titanlink' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(suggested).getByRole('button', { name: 'Confirm Titanlink' }));
    });

    await waitFor(() =>
      expect(store.get(chatId('Relay rollout'))?.item.filing).toEqual({ projectId: tl.id, filedBy: 'user' }),
    );
    await waitFor(() =>
      expect(within(row('Relay rollout')).getByRole('img', { name: 'Titanlink' })).toBeTruthy(),
    );
    await waitFor(() => expect(within(view()).getByText('Confirmed Ares’s filing under TL')).toBeTruthy());
    expect(within(view()).queryByTestId('suggested-filing')).toBeNull();
  });

  it('Change opens the Badge picker with his suggestion on top; another Project is recorded as a correction', async () => {
    renderSheet();
    await waitFor(() => expect(row('Pager talk')).toBeTruthy());
    fireEvent.click(row('Pager talk'));
    const suggested = await within(view()).findByTestId('suggested-filing');
    fireEvent.click(within(suggested).getByRole('button', { name: 'Change the Project' }));

    const picker = screen.getByRole('dialog', { name: 'Badge picker' });
    expect(within(picker).getByTestId('badge-picker-suggestion').textContent).toContain(
      'Ares suggests Titanlink',
    );
    const input = within(picker).getByRole('combobox');
    fireEvent.change(input, { target: { value: 'tx' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    await waitFor(() =>
      expect(store.get(chatId('Pager talk'))?.item.filing).toEqual({ projectId: tx.id, filedBy: 'user' }),
    );
    await waitFor(() => expect(within(view()).getByText('Corrected Ares: TL → TX')).toBeTruthy());
    expect(within(row('Pager talk')).getByRole('img', { name: 'Tactics' })).toBeTruthy();
  });

  it('a click on the dashed Badge in a row opens the picker with Confirm', async () => {
    renderSheet();
    await waitFor(() =>
      expect(within(row('Pager talk')).getByRole('img', { name: 'Ares suggests Titanlink' })).toBeTruthy(),
    );
    fireEvent.click(within(row('Pager talk')).getByRole('button', { name: 'Project of Pager talk' }));
    const picker = screen.getByRole('dialog', { name: 'Badge picker' });
    await act(async () => {
      fireEvent.click(
        within(within(picker).getByTestId('badge-picker-suggestion')).getByRole('button', {
          name: 'Confirm',
        }),
      );
    });
    await waitFor(() =>
      expect(store.get(chatId('Pager talk'))?.item.filing).toEqual({ projectId: tl.id, filedBy: 'user' }),
    );
  });
});
