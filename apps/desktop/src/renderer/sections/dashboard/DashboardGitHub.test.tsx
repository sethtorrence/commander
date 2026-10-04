// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { ReviewRequestDetail, SourceItem } from '@commander/domain';
import type { AccountSummary } from '@commander/domain/ipc';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onReveal } from '../../frame/reveal';
import { openTestItemStore } from '../../item-store/test-item-store';
import { ProjectsProvider } from '../../projects/context';
import { type ProjectsClient, projectsIn } from '../../projects/projects';
import { ShortcutProvider, ShortcutScope, useActiveScopes } from '../../shortcuts/react';
import { GITHUB, NOW, pull, reviewRequest } from '../github/test-work';
import type { LinearAccountsClient } from '../linear/linear-issues';
import { FrameControlsProvider, SectionProvider } from '../section';
import { dashboard as definition } from '.';
import { DashboardProvider } from './context';
import { DashboardSheet } from './DashboardSheet';
import { type DashboardClient, dashboardIn } from './dashboard';

// GitHub's open work on the Dashboard (#116): pull requests and review requests saved as GitHub sync
// saves them, in a real Item store, ranked by the band rules (Ares hasn't ranked yet). Who the User
// is on GitHub comes from the Account's login.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let store: ItemStore;
let projects: ProjectsClient;
let client: DashboardClient;
let close: () => void;
const clock = NOW;
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };

const githubAccount: AccountSummary = {
  id: GITHUB,
  source: 'github',
  name: 'octocat',
  login: 'octocat',
  signedInWith: 'classic-token',
  installations: null,
  installUrl: null,
  method: 'api-key',
  status: 'connected',
  user: { id: '583231', name: 'The Octocat' },
  sync: null,
};

const accounts: LinearAccountsClient = {
  list: async () => [githubAccount],
  syncNow: async () => {},
  onChange: () => () => {},
};

function request(number: number, changes: Partial<ReviewRequestDetail>, title: string): SourceItem {
  const source = reviewRequest(number);
  return {
    ...source,
    title,
    people: ['github:priya'],
    detail: { ...(source.detail as ReviewRequestDetail), requestedAt: NOW - 2 * DAY, ...changes },
  };
}

const save = (items: SourceItem[], deleted: string[] = []) =>
  store.saveFromSource({ source: 'github', account: GITHUB, items, deleted });

beforeEach(() => {
  const opened = openTestItemStore(() => clock);
  ({ store, close } = opened);
  projects = projectsIn(opened.client);
  client = dashboardIn(opened.client, accounts);
  localStorage.clear();
  for (const mock of Object.values(controls)) mock.mockReset();
  Element.prototype.scrollIntoView = () => {};
  store.githubWatch.saveAccess(GITHUB, {
    via: 'token',
    login: 'octocat',
    orgs: [],
    personal: [],
    fetchedAt: NOW,
  });
  save([
    pull({ number: 12, title: 'Retry webhooks', author: 'priya' }),
    pull({ number: 14, title: 'Bump the SDK', author: 'dana' }),
    pull({ number: 20, title: 'Cache session lookups', author: 'octocat', checks: 'failure' }),
    pull({
      number: 21,
      title: 'Paginate exports',
      author: 'octocat',
      requestedReviewers: [{ kind: 'user', login: 'omar', requestedAt: NOW - 3 * DAY }],
    }),
    request(12, {}, 'Retry webhooks'),
    request(14, { direct: false, teams: ['acme/backend'] }, 'Bump the SDK'),
  ]);
});

afterEach(() => {
  cleanup();
  close();
});

function Active({ children }: { children: ReactNode }) {
  useActiveScopes(['dashboard']);
  return children;
}

function renderSheet() {
  return render(
    <ShortcutProvider>
      <ProjectsProvider client={projects} storage={localStorage}>
        <DashboardProvider client={client} storage={localStorage} clock={() => clock}>
          <FrameControlsProvider value={controls}>
            <SectionProvider place={{ definition, number: 1, total: 8, active: true }}>
              <ShortcutScope scope="dashboard" group="Dashboard">
                <Active>
                  <DashboardSheet />
                </Active>
              </ShortcutScope>
            </SectionProvider>
          </FrameControlsProvider>
        </DashboardProvider>
      </ProjectsProvider>
    </ShortcutProvider>,
  );
}

const press = (key: string) =>
  act(() => {
    fireEvent.keyDown(document.body, { key });
  });
const titles = (name: string) =>
  within(screen.getByRole('region', { name }))
    .queryAllByTestId('dashboard-row')
    .map((row) => row.getAttribute('aria-label'));
const row = (title: string) => screen.getByRole('listitem', { name: title });
const idOf = (externalId: string) =>
  store.query({ kinds: ['pull-request', 'review-request'] }).find((item) => item.externalId === externalId)
    ?.id as string;

describe('GitHub on the Dashboard', () => {
  it('ranks a direct review in Today, a team’s in FYI, failing checks in Today and a waiting pull request in Waiting on others, stamped GH', async () => {
    renderSheet();
    await waitFor(() => expect(titles('Today')).toHaveLength(2));
    expect(titles('Today')).toEqual(
      expect.arrayContaining(['acme/api#12 Retry webhooks', 'acme/api#20 Cache session lookups']),
    );
    expect(titles('Waiting on others')).toEqual(['acme/api#21 Paginate exports']);
    expect(titles('FYI')).toEqual(['acme/api#14 Bump the SDK']);
    // The review's Todo is shown once, by its request.
    expect(screen.queryByRole('listitem', { name: 'Review: Retry webhooks' })).toBeNull();

    const review = row('acme/api#12 Retry webhooks');
    expect(within(review).getByTestId('source-stamp').textContent).toBe('GHReview requested');
    expect(within(review).getByTestId('row-reason').textContent).toBe('priya asked for your review · 2 days');
    expect(within(row('acme/api#20 Cache session lookups')).getByTestId('row-reason').textContent).toBe(
      'Checks failing on your PR',
    );
    expect(within(row('acme/api#14 Bump the SDK')).getByTestId('row-reason').textContent).toBe(
      'Review requested from @acme/backend',
    );
  });

  it('opens a review request’s pull request in the GitHub Section with Enter', async () => {
    renderSheet();
    await waitFor(() => expect(titles('Today')).toHaveLength(2));
    const heard: string[] = [];
    const stop = onReveal('github', (itemId) => heard.push(itemId));
    fireEvent.click(row('acme/api#12 Retry webhooks'));
    await press('Enter');
    expect(controls.openSection).toHaveBeenLastCalledWith('github');
    expect(heard).toEqual([idOf('R_api:pull/12')]);
    stop();
  });

  it('ticking a review request ticks its Todo, and once the review is submitted the row is gone', async () => {
    renderSheet();
    await waitFor(() => expect(titles('Today')).toHaveLength(2));
    fireEvent.click(row('acme/api#12 Retry webhooks'));
    await press('x');
    await waitFor(() =>
      expect(store.query({ kinds: ['todo'], statuses: ['done'] }).map((todo) => todo.title)).toEqual([
        'Review: Retry webhooks',
      ]),
    );
    // Untick again: the review is still asked for.
    await press('x');
    await waitFor(() => expect(store.query({ kinds: ['todo'], statuses: ['done'] })).toEqual([]));

    save(
      [
        pull({
          number: 12,
          title: 'Retry webhooks',
          author: 'priya',
          reviews: [{ login: 'octocat', state: 'approved', submittedAt: NOW }],
        }),
      ],
      ['R_api:review-request/12'],
    );
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(titles('Today')).toEqual(['acme/api#20 Cache session lookups']));
  });
});

describe('Ares’s GitHub summary on the Dashboard (#121)', () => {
  function summary(title: string, onFire: string[] = [], writtenAt = NOW - 2 * HOUR): string {
    return store.record(
      {
        type: 'create',
        item: {
          kind: 'github-summary',
          title,
          detail: {
            kind: 'github-summary',
            cadence: 'daily',
            day: '2026-10-03',
            range: { from: NOW - DAY, to: writtenAt },
            choice: null,
            writtenAt,
            sections: [],
            onFire,
            counts: { shipped: 3, started: 1, stuck: 1, onFire: onFire.length },
            seenAt: null,
          },
        },
      },
      { by: { kind: 'ares' } },
    ).itemId;
  }

  it('is one row for the latest, in FYI with its counts', async () => {
    summary('GitHub summary · since Thu 1 Oct', [], NOW - DAY);
    summary('GitHub summary · since yesterday');
    renderSheet();
    await waitFor(() => expect(titles('FYI')).toContain('GitHub summary · since yesterday'));
    expect(titles('FYI')).not.toContain('GitHub summary · since Thu 1 Oct');
    const shown = row('GitHub summary · since yesterday');
    expect(within(shown).getByTestId('source-stamp').textContent).toBe('ARESGitHub summary');
    expect(within(shown).getByTestId('row-reason').textContent).toBe('3 shipped · 1 started · 1 stuck');
  });

  it('sits in Today when something is on fire, and Enter opens it in the GitHub Section', async () => {
    const id = summary('GitHub summary · since yesterday', ['Main is failing on acme/titanlink-api']);
    renderSheet();
    await waitFor(() => expect(titles('Today')).toContain('GitHub summary · since yesterday'));
    expect(within(row('GitHub summary · since yesterday')).getByTestId('row-reason').textContent).toBe(
      'Main is failing on acme/titanlink-api',
    );
    const heard: string[] = [];
    const stop = onReveal('github', (itemId) => heard.push(itemId));
    fireEvent.click(row('GitHub summary · since yesterday'));
    await press('Enter');
    expect(controls.openSection).toHaveBeenLastCalledWith('github');
    expect(heard).toEqual([id]);
    stop();
  });

  it('clears with e until the next one', async () => {
    summary('GitHub summary · since yesterday');
    renderSheet();
    await waitFor(() => expect(titles('FYI')).toContain('GitHub summary · since yesterday'));
    fireEvent.click(row('GitHub summary · since yesterday'));
    await press('e');
    await waitFor(() => expect(titles('FYI')).not.toContain('GitHub summary · since yesterday'));
    summary('GitHub summary · since this morning', [], NOW - HOUR);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(titles('FYI')).toContain('GitHub summary · since this morning'));
  });
});
