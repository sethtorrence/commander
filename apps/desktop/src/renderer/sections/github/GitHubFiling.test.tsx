// @vitest-environment jsdom
import { createFiling } from '@commander/core/src/agent/filing';
import { type Gate, openGate } from '@commander/core/src/autonomy/gate';
import { answerAutonomyRequest } from '@commander/core/src/autonomy/requests';
import type { ItemStore } from '@commander/core/src/item-store';
import { FILE_INTO_PROJECTS, type Project } from '@commander/domain';
import type { GitHubAccountSummary } from '@commander/domain/ipc';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openTestItemStore } from '../../item-store/test-item-store';
import { ProjectsProvider } from '../../projects/context';
import { type ProjectsClient, projectsIn } from '../../projects/projects';
import { ShortcutProvider, ShortcutScope, useActiveScopes } from '../../shortcuts/react';
import type { AutonomyClient } from '../ares/activity';
import { FrameControlsProvider, SectionProvider } from '../section';
import { github as definition } from '.';
import { GitHubSheet } from './GitHubSheet';
import { type GitHubAccountsClient, type GitHubWork, githubWorkIn } from './github-work';
import { GITHUB, NOW, pull, reviewRequest } from './test-work';

// Ares's filing on GitHub Items in the GitHub Section (#118): a pull request he wasn't sure about
// wears his dashed Badge on its row and in its detail pane, where Confirm files it by the User (and
// its review request follows). A real Item store and gate on a temporary database.

let store: ItemStore;
let gate: Gate;
let work: GitHubWork;
let projects: ProjectsClient;
let close: () => void;
let tl: Project;
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };

const octocat: GitHubAccountSummary = {
  id: GITHUB,
  source: 'github',
  name: 'octocat',
  login: 'octocat',
  signedInWith: 'github-app',
  installations: ['acme'],
  installUrl: null,
  method: 'oauth',
  status: 'connected',
  user: { id: '583231', name: 'octocat' },
  sync: null,
};
const accounts: GitHubAccountsClient = {
  list: async () => [octocat],
  syncNow: async () => {},
  onChange: () => () => {},
};

const idOf = (title: string) => store.query({ source: 'github', titleContains: title })[0]?.id ?? '';

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  const opened = openTestItemStore();
  ({ store, close } = opened);
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
  work = githubWorkIn(opened.client, { githubDiscussion: async () => ({ ok: false, error: 'offline' }) });
  projects = projectsIn(opened.client, () => autonomy as never);
  localStorage.clear();
  localStorage.setItem('commander.github.view', 'pulls');
  Element.prototype.scrollIntoView = () => {};
  tl = store.changeProject({ type: 'create', project: { name: 'Titanlink', code: 'TL', accent: 'teal' } })
    .project as Project;
  store.saveFromSource({
    source: 'github',
    account: GITHUB,
    items: [pull({ number: 12, title: 'Retry the relay' }), reviewRequest(12)],
  });
  // Ares, unsure, suggests Titanlink for the pull request.
  const itemId = idOf('Retry the relay');
  gate.propose({
    actionKind: 'organise',
    action: FILE_INTO_PROJECTS,
    section: 'github',
    itemId,
    itemActions: [{ type: 'update', itemId, changes: { filing: { projectId: tl.id, filedBy: 'ares' } } }],
    confidence: 0.55,
    reason: 'Titanlink’s API repo',
  });
});

afterEach(() => {
  cleanup();
  close();
  vi.useRealTimers();
});

function Active({ children }: { children: ReactNode }) {
  useActiveScopes(['github']);
  return children;
}

function renderSheet() {
  return render(
    <ShortcutProvider>
      <ProjectsProvider client={projects} storage={localStorage}>
        <FrameControlsProvider value={controls}>
          <SectionProvider place={{ definition, number: 7, total: 8, active: true }}>
            <ShortcutScope scope="github" group="GitHub">
              <Active>
                <GitHubSheet work={work} accounts={accounts} />
              </Active>
            </ShortcutScope>
          </SectionProvider>
        </FrameControlsProvider>
      </ProjectsProvider>
    </ShortcutProvider>,
  );
}

const row = (title: string) =>
  screen.getAllByTestId('github-work').find((each) => each.getAttribute('aria-label')?.endsWith(title));

describe('Ares’s filing on GitHub Items', () => {
  it('shows the dashed Badge on the pull request’s row and in its pane, where Confirm files it by the User', async () => {
    renderSheet();
    await waitFor(() =>
      expect(
        within(row('Retry the relay') as HTMLElement).getByRole('img', { name: 'Ares suggests Titanlink' }),
      ).toBeTruthy(),
    );
    fireEvent.click(row('Retry the relay') as HTMLElement);
    const pane = await screen.findByRole('region', { name: 'Pull request detail' });
    const suggested = await within(pane).findByTestId('suggested-filing');
    await act(async () => {
      fireEvent.click(within(suggested).getByRole('button', { name: 'Confirm Titanlink' }));
    });

    await waitFor(() =>
      expect(store.get(idOf('Retry the relay'))?.item.filing).toEqual({ projectId: tl.id, filedBy: 'user' }),
    );
    // Its review request (the Dashboard's row) follows it.
    expect(store.query({ kinds: ['review-request'] })[0]?.filing).toEqual({
      projectId: tl.id,
      filedBy: 'inherited',
    });
    await waitFor(() =>
      expect(
        within(row('Retry the relay') as HTMLElement).getByRole('img', { name: 'Titanlink' }),
      ).toBeTruthy(),
    );
  });
});
