// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { Project } from '@commander/domain';
import type { AccountSummary, AccountSyncStatus } from '@commander/domain/ipc';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onReveal } from '../../frame/reveal';
import { openTestItemStore } from '../../item-store/test-item-store';
import { ProjectsProvider } from '../../projects/context';
import { type ProjectsClient, projectsIn } from '../../projects/projects';
import { ShortcutProvider, ShortcutScope, useActiveScopes } from '../../shortcuts/react';
import type { LinearAccountsClient } from '../linear/linear-issues';
import { FrameControlsProvider, SectionProvider } from '../section';
import { chat, HOUR, LEE, message, NOW, PRIYA, SAM, TEAMS } from '../teams/test-chats';
import { dashboard as definition } from '.';
import { DashboardProvider } from './context';
import { DashboardSheet } from './DashboardSheet';
import { type DashboardClient, dashboardIn } from './dashboard';
import { ProjectRankedList } from './ProjectRankedList';

// Teams on the Dashboard (#107): Chats saved as Teams sync saves them, in a real Item store, ranked
// by the band rules (Ares hasn't ranked yet). The clock is fixed: Saturday 3 October 2026, 12:00.

const MINUTE = 60_000;
const DANA = { userId: 'u-dana', name: 'Dana Whitfield' };
const members = (...people: { userId: string | null; name: string }[]) =>
  [SAM, ...people].map((person) => ({ userId: person.userId, name: person.name, email: null }));

let store: ItemStore;
let projects: ProjectsClient;
let client: DashboardClient;
let accounts: ReturnType<typeof fakeAccounts>;
let close: () => void;
let clock = NOW;
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };

const syncStatus = (account: string, lastSyncedAt: number): AccountSyncStatus => ({
  account,
  source: 'teams',
  activity: 'idle',
  cadenceMinutes: 1440,
  cadenceChoices: [1440],
  lastSyncedAt,
  nextSyncAt: null,
  itemCount: 4,
  problem: null,
  outgoing: { pending: 0, failed: 0 },
});

const teamsAccount = (
  id: string,
  status: AccountSummary['status'] = 'connected',
  lastSyncedAt = NOW - MINUTE,
): AccountSummary => ({
  id,
  source: 'teams',
  name: 'Teams · sam@contoso.test',
  userPrincipalName: 'sam@contoso.test',
  method: 'oauth',
  status,
  user: { id: SAM.userId ?? '', name: SAM.name },
  sync: syncStatus(id, lastSyncedAt),
});

const linearAccount: AccountSummary = {
  id: 'linear:acme',
  source: 'linear',
  name: 'Acme',
  urlKey: 'acme',
  method: 'api-key',
  status: 'connected',
  user: { id: 'user-sam', name: 'Sam Rivera' },
  sync: null,
};

function fakeAccounts(initial: AccountSummary[]) {
  let current = initial;
  const listeners = new Set<(accounts: AccountSummary[]) => void>();
  const synced: string[] = [];
  const client: LinearAccountsClient = {
    list: async () => current,
    syncNow: async (id) => {
      synced.push(id);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    client,
    synced,
    change(next: AccountSummary[]) {
      current = next;
      act(() => {
        for (const listener of listeners) listener(next);
      });
    },
  };
}

const launchMention = message(PRIYA, 'Can you sign off on the launch?', 78 * MINUTE, { mentions: [SAM] });
const danaAsks = message(DANA, 'Got a minute for the Q3 numbers?', 40 * MINUTE);
const socialChatter = Array.from({ length: 12 }, (_, i) =>
  message(i % 2 ? LEE : PRIYA, i ? 'lol' : 'Sam, coming to lunch?', (i + 1) * MINUTE),
);

// A Teams sync: a mention in a group Chat, an unanswered one-to-one Chat, an answered one, a busy
// group Chat that doesn't mention the User, and a muted Chat that does.
function syncTeams(extra: { id: string; messages: ReturnType<typeof message>[] }[] = []) {
  const more = new Map(extra.map((each) => [each.id, each.messages]));
  store.saveFromSource({
    source: 'teams',
    account: TEAMS,
    me: SAM.userId,
    items: [
      chat({
        id: '19:launch',
        title: 'Launch crew',
        chatType: 'group',
        topic: 'Launch crew',
        members: members(PRIYA, LEE),
        messages: [message(LEE, 'Morning', 3 * HOUR), launchMention],
      }),
      chat({
        id: '19:dana',
        title: 'Dana Whitfield',
        members: members(DANA),
        messages: [message(SAM, 'Ping', 2 * HOUR), danaAsks, ...(more.get('19:dana') ?? [])],
      }),
      chat({
        id: '19:lee',
        title: 'Lee Chen',
        members: members(LEE),
        lastReadAt: NOW - HOUR,
        messages: [message(LEE, 'Lunch?', 2 * HOUR), message(SAM, 'Sure', HOUR)],
      }),
      chat({
        id: '19:social',
        title: 'Social',
        chatType: 'group',
        topic: 'Social',
        members: members(PRIYA, LEE),
        messages: [...socialChatter, ...(more.get('19:social') ?? [])],
      }),
      chat({
        id: '19:alerts',
        title: 'Alerts',
        chatType: 'group',
        topic: 'Alerts',
        members: members(PRIYA),
        messages: [message(PRIYA, 'Deploy failed', 10 * MINUTE, { mentions: [SAM] })],
      }),
    ],
  });
}

const chatId = (externalId: string) =>
  store.query({ kinds: ['chat'] }).find((item) => item.externalId === externalId)?.id as string;

beforeEach(() => {
  clock = NOW;
  const opened = openTestItemStore(() => clock);
  ({ store, close } = opened);
  projects = projectsIn(opened.client);
  accounts = fakeAccounts([linearAccount, teamsAccount(TEAMS)]);
  client = dashboardIn(opened.client, accounts.client);
  localStorage.clear();
  for (const mock of Object.values(controls)) mock.mockReset();
  Element.prototype.scrollIntoView = () => {};
  syncTeams();
  store.chatSettings.change(
    { account: TEAMS, chatId: '19:alerts', change: 'mute' },
    { by: { kind: 'user' } },
  );
});

afterEach(() => {
  cleanup();
  close();
});

function Active({ children }: { children: ReactNode }) {
  useActiveScopes(['dashboard']);
  return children;
}

function renderSheet(active = true) {
  const place = { definition, number: 1, total: 8, active };
  const tree = (now: boolean) => (
    <ShortcutProvider>
      <ProjectsProvider client={projects} storage={localStorage}>
        <DashboardProvider client={client} storage={localStorage} clock={() => clock}>
          <FrameControlsProvider value={controls}>
            <SectionProvider place={{ ...place, active: now }}>
              <ShortcutScope scope="dashboard" group="Dashboard">
                <Active>
                  <DashboardSheet />
                </Active>
              </ShortcutScope>
            </SectionProvider>
          </FrameControlsProvider>
        </DashboardProvider>
      </ProjectsProvider>
    </ShortcutProvider>
  );
  const view = render(tree(active));
  return { ...view, setActive: (now: boolean) => view.rerender(tree(now)) };
}

const press = (key: string) =>
  act(() => {
    fireEvent.keyDown(document.body, { key });
  });
const band = (name: string) => screen.getByRole('region', { name });
const titles = (name: string) =>
  within(band(name))
    .queryAllByTestId('dashboard-row')
    .map((row) => row.getAttribute('aria-label'));
const row = (title: string) => screen.getByRole('listitem', { name: title });

async function loaded() {
  await waitFor(() => expect(titles('Today')).toHaveLength(2));
}

describe('Teams on the Dashboard', () => {
  it('shows a mention and an unanswered one-to-one Chat in Today, stamped TMS with a Badge and the reason', async () => {
    renderSheet();
    await loaded();
    // The latest first; never the answered Chat, the busy group Chat, or the muted one.
    expect(titles('Today')).toEqual(['Dana Whitfield', 'Launch crew']);
    expect(screen.queryByRole('listitem', { name: 'Social' })).toBeNull();
    expect(screen.queryByRole('listitem', { name: 'Lee Chen' })).toBeNull();
    expect(screen.queryByRole('listitem', { name: 'Alerts' })).toBeNull();

    const launch = row('Launch crew');
    expect(within(launch).getByTestId('source-stamp').textContent).toBe('TMSGroup chat');
    expect(within(launch).getByTestId('row-reason').textContent).toBe(
      'Priya mentioned you in Launch crew · 10:42',
    );
    expect(within(launch).getByRole('button', { name: 'Project of Launch crew' })).toBeTruthy();
    expect(within(row('Dana Whitfield')).getByTestId('row-reason').textContent).toBe(
      'Dana messaged you 40 min ago',
    );
    // The Dashboard tab counts them, with Now and Today.
    await waitFor(() => expect(controls.setTabCount).toHaveBeenLastCalledWith('dashboard', 2));
  });

  it('opens the Chat in the Teams Section at the message that put it there, with Enter', async () => {
    renderSheet();
    await loaded();
    const heard: [string, string | undefined][] = [];
    const stop = onReveal('teams', (itemId, focus) => heard.push([itemId, focus]));
    fireEvent.click(row('Launch crew'));
    await press('Enter');
    expect(controls.openSection).toHaveBeenLastCalledWith('teams');
    expect(heard).toEqual([[chatId('19:launch'), launchMention.id]]);
    stop();
  });

  it('doesn’t tick a Chat with x', async () => {
    renderSheet();
    await loaded();
    fireEvent.click(row('Dana Whitfield'));
    await press('x');
    expect(store.get(chatId('19:dana'))?.item.status).toBe('open');
    expect(titles('Today')).toContain('Dana Whitfield');
  });

  it('clears a Chat with e until it gets a newer qualifying message', async () => {
    renderSheet();
    await loaded();
    fireEvent.click(row('Dana Whitfield'));
    await press('e');
    await waitFor(() => expect(titles('Today')).toEqual(['Launch crew']));

    // A sync with nothing new: it stays cleared.
    clock = NOW + 5 * MINUTE;
    syncTeams();
    accounts.change([linearAccount, teamsAccount(TEAMS, 'connected', clock)]);
    await waitFor(() => expect(store.dashboard.clears()).toHaveLength(1));
    expect(titles('Today')).toEqual(['Launch crew']);

    // Dana writes again: the row is back.
    clock = NOW + 10 * MINUTE;
    syncTeams([{ id: '19:dana', messages: [message(DANA, 'Still there?', -9 * MINUTE)] }]);
    accounts.change([linearAccount, teamsAccount(TEAMS, 'connected', clock)]);
    await waitFor(() => expect(titles('Today')).toEqual(['Dana Whitfield', 'Launch crew']));
    expect(within(row('Dana Whitfield')).getByTestId('row-reason').textContent).toBe(
      'Dana messaged you 1 min ago',
    );
  });

  it('shows a Chat Ares flagged as waiting on the User in Today with his reason, opening at the message (#109)', async () => {
    // The busy group Chat: nothing mentions the User, but Priya asked them something.
    const social = chatId('19:social');
    const detail = store.get(social)?.item.detail;
    const asked = detail?.kind === 'chat' ? (detail.messages[0]?.id as string) : '';
    store.chatWaiting.flag(
      social,
      { messageId: asked, reason: 'Priya asked if you’re coming to lunch' },
      NOW,
    );
    renderSheet();
    await waitFor(() => expect(titles('Today')).toHaveLength(3));
    expect(within(row('Social')).getByTestId('row-reason').textContent).toBe(
      'Priya asked if you’re coming to lunch',
    );

    const heard: [string, string | undefined][] = [];
    const stop = onReveal('teams', (itemId, focus) => heard.push([itemId, focus]));
    fireEvent.click(row('Social'));
    await press('Enter');
    expect(heard).toEqual([[social, asked]]);
    stop();

    // The User answers: the row goes.
    clock = NOW + 5 * MINUTE;
    syncTeams([{ id: '19:social', messages: [message(SAM, 'Coming!', -4 * MINUTE)] }]);
    accounts.change([linearAccount, teamsAccount(TEAMS, 'connected', clock)]);
    await waitFor(() => expect(titles('Today')).toEqual(['Dana Whitfield', 'Launch crew']));
  });

  it('leaves an unanswered one-to-one Chat once the User replies', async () => {
    renderSheet();
    await loaded();
    clock = NOW + 5 * MINUTE;
    syncTeams([{ id: '19:dana', messages: [message(SAM, 'Sure, 2pm?', -4 * MINUTE)] }]);
    accounts.change([linearAccount, teamsAccount(TEAMS, 'connected', clock)]);
    await waitFor(() => expect(titles('Today')).toEqual(['Launch crew']));
  });

  it('ranks a filed Chat on its Project page, and opens it there at its message', async () => {
    const project = store.changeProject({
      type: 'create',
      project: { name: 'Titanlink', code: 'TL', accent: '#00BFA5' },
    }).project as Project;
    store.record(
      {
        type: 'update',
        itemId: chatId('19:launch'),
        changes: { filing: { projectId: project.id, filedBy: 'user' } },
      },
      { by: { kind: 'user' } },
    );
    const onOpenSection = vi.fn();
    render(
      <ShortcutProvider>
        <ProjectsProvider client={projects} storage={localStorage}>
          <DashboardProvider client={client} storage={localStorage} clock={() => clock}>
            <ProjectRankedList projectId={project.id} projectName="Titanlink" onOpenSection={onOpenSection} />
          </DashboardProvider>
        </ProjectsProvider>
      </ShortcutProvider>,
    );
    await waitFor(() => expect(titles('Today')).toEqual(['Launch crew']));
    const heard: [string, string | undefined][] = [];
    const stop = onReveal('teams', (itemId, focus) => heard.push([itemId, focus]));
    fireEvent.doubleClick(row('Launch crew'));
    expect(onOpenSection).toHaveBeenCalledWith('teams');
    expect(heard).toEqual([[chatId('19:launch'), launchMention.id]]);
    stop();
  });

  it('asks every connected Teams Account for a light sync when the Dashboard opens', async () => {
    accounts.change([
      linearAccount,
      teamsAccount(TEAMS),
      teamsAccount('teams:tenant:old', 'needs-reconnect'),
    ]);
    const { setActive } = renderSheet(false);
    await waitFor(() => expect(screen.getByTestId('ranked-list')).toBeTruthy());
    expect(accounts.synced).toEqual([]);
    setActive(true);
    await waitFor(() => expect(accounts.synced).toEqual([TEAMS]));
    setActive(false);
    setActive(true);
    await waitFor(() => expect(accounts.synced).toEqual([TEAMS, TEAMS]));
  });
});
