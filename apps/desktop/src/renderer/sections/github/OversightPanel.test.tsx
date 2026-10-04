// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import {
  type GitHubSummaryDetail,
  type GitHubSummaryEntry,
  type OversightSectionKind,
  WRITE_GITHUB_SUMMARY,
} from '@commander/domain';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemStoreClient } from '../../item-store/client';
import { openTestItemStore } from '../../item-store/test-item-store';
import { ProjectsProvider } from '../../projects/context';
import { type ProjectsClient, projectsIn } from '../../projects/projects';
import { ShortcutProvider, ShortcutScope } from '../../shortcuts/react';
import { FrameControlsProvider, SectionProvider } from '../section';
import { github as definition } from '.';
import { GitHubSheet } from './GitHubSheet';
import { type GitHubAccountsClient, githubWorkIn } from './github-work';
import { type OversightClient, oversightIn } from './oversight';
import { API, GITHUB, issue, pull, WEB } from './test-work';

// The oversight summary at the top of the GitHub Section (#119), in plain lines with
// its range and Project pickers, against a real Item store; every line opens its Items in the
// Section below.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Sunday 4 October 2026, 15:00 local.
const NOW = new Date(2026, 9, 4, 15, 0).getTime();

let store: ItemStore;
let client: ItemStoreClient;
let close: () => void;
let projects: ProjectsClient;
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };
const accounts: GitHubAccountsClient = {
  list: async () => [],
  syncNow: async () => {},
  onChange: () => () => {},
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  ({ store, client, close } = openTestItemStore());
  projects = projectsIn(client);
  localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
  store.saveFromSource({
    source: 'github',
    account: GITHUB,
    items: [
      pull({
        number: 41,
        title: 'Retry webhooks',
        state: 'merged',
        mergedAt: NOW - 3 * HOUR,
        closedAt: NOW - 3 * HOUR,
      }),
      pull({
        number: 42,
        title: 'Cache sessions',
        state: 'merged',
        mergedAt: NOW - 5 * HOUR,
        closedAt: NOW - 5 * HOUR,
      }),
      // Merged on Tuesday: in This week, not since yesterday.
      pull({
        number: 40,
        title: 'Older merge',
        state: 'merged',
        mergedAt: NOW - 4 * DAY,
        closedAt: NOW - 4 * DAY,
      }),
      pull({
        number: 12,
        title: 'Dark mode',
        repo: WEB,
        createdAt: NOW - 10 * DAY,
        requestedReviewers: [{ kind: 'user', login: 'omar', requestedAt: NOW - 4 * DAY }],
      }),
      issue({ number: 30, title: 'Webhooks drop on 502', createdAt: NOW - 2 * HOUR }),
    ],
  });
  store.syncState.saveCatalog(
    GITHUB,
    'github',
    {
      kind: 'github',
      repos: [
        {
          repo: API,
          defaultBranch: 'main',
          head: { oid: 'abc1234', checks: 'failure', committedAt: NOW - HOUR },
          commits: [],
          checkedAt: NOW - HOUR,
        },
      ],
    },
    NOW,
  );
});

afterEach(() => {
  cleanup();
  close();
  vi.useRealTimers();
});

function renderSheet(oversight: OversightClient = oversightIn(client)) {
  return render(
    <ShortcutProvider>
      <ProjectsProvider client={projects} storage={localStorage}>
        <FrameControlsProvider value={controls}>
          <SectionProvider place={{ definition, number: 7, total: 8, active: true }}>
            <ShortcutScope scope="github" group="GitHub">
              <GitHubSheet
                work={githubWorkIn(client, { githubDiscussion: async () => ({ ok: false, error: 'none' }) })}
                accounts={accounts}
                oversight={oversight}
              />
            </ShortcutScope>
          </SectionProvider>
        </FrameControlsProvider>
      </ProjectsProvider>
    </ShortcutProvider>,
  );
}

const summary = () => screen.getByRole('region', { name: 'Oversight summary' });
const lines = () =>
  within(summary())
    .queryAllByTestId('github-summary-line')
    .map((line) => line.textContent);
const listed = () => screen.queryAllByTestId('github-work').map((row) => row.getAttribute('aria-label'));

describe('the oversight summary', () => {
  it('shows since yesterday by default: Shipped, Started, Stuck and On fire', async () => {
    renderSheet();
    await waitFor(() =>
      expect(lines()).toEqual([
        'acme/api: 2 PRs merged',
        'acme/api: 1 issue opened',
        'acme/web#12 Dark mode: waiting 4 days on omar',
        'acme/api: main is failing its checks',
      ]),
    );
    expect(
      within(summary()).getByRole('button', { name: 'Since yesterday' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(within(summary()).queryByTestId('github-summary-closing')).toBeNull();
  });

  it('switches to this week, and to a custom day', async () => {
    renderSheet();
    await waitFor(() => expect(lines()[0]).toBe('acme/api: 2 PRs merged'));
    fireEvent.click(within(summary()).getByRole('button', { name: 'This week' }));
    await waitFor(() => expect(lines()[0]).toBe('acme/api: 3 PRs merged'));
    fireEvent.click(within(summary()).getByRole('button', { name: 'Custom since…' }));
    fireEvent.change(within(summary()).getByLabelText('Summary since'), { target: { value: '2026-10-04' } });
    await waitFor(() => expect(lines()[0]).toBe('acme/api: 2 PRs merged'));
  });

  it('keeps to one Project, saying "Nothing on fire" when nothing is', async () => {
    const titanlink = await projects.create({ name: 'Titanlink', code: 'TL', accent: 'blue' });
    const dark = store.query({ titleContains: 'Dark mode' })[0];
    store.record(
      {
        type: 'update',
        itemId: dark?.id ?? '',
        changes: { filing: { projectId: titanlink.id, filedBy: 'user' } },
      },
      { by: { kind: 'user' } },
    );
    renderSheet();
    await waitFor(() => expect(lines()).toHaveLength(4));
    fireEvent.click(within(summary()).getByRole('combobox', { name: 'Summary Project' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Titanlink' }));
    await waitFor(() => expect(lines()).toEqual(['acme/web#12 Dark mode: waiting 4 days on omar']));
    expect(within(summary()).getAllByText('Titanlink').length).toBeGreaterThan(0);
    expect(within(summary()).getByTestId('github-summary-closing').textContent).toBe('Nothing on fire');
  });

  it('opens a line’s Items in the Section: several together, one in its detail, a repo by its filter', async () => {
    renderSheet();
    await waitFor(() => expect(lines()).toHaveLength(4));

    fireEvent.click(within(summary()).getByRole('button', { name: 'acme/api: 2 PRs merged' }));
    await waitFor(() =>
      expect(listed()).toEqual(['acme/api#41 Retry webhooks', 'acme/api#42 Cache sessions']),
    );
    expect(screen.getByTestId('github-only').textContent).toContain('Showing 2 from the summary');
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    await waitFor(() => expect(screen.queryByTestId('github-only')).toBeNull());

    fireEvent.click(
      within(summary()).getByRole('button', { name: 'acme/web#12 Dark mode: waiting 4 days on omar' }),
    );
    await waitFor(() => expect(screen.getByRole('region', { name: 'Pull request detail' })).toBeTruthy());

    fireEvent.click(within(summary()).getByRole('button', { name: 'acme/api: main is failing its checks' }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Repo' }).textContent).toContain('acme/api'),
    );
  });

  it('folds away, and stays folded', async () => {
    const { unmount } = renderSheet();
    await waitFor(() => expect(lines()).toHaveLength(4));
    fireEvent.click(within(summary()).getByRole('button', { name: /Summary/ }));
    expect(lines()).toEqual([]);
    unmount();
    renderSheet();
    await act(async () => {});
    expect(
      within(summary())
        .getByRole('button', { name: /Summary/ })
        .getAttribute('aria-expanded'),
    ).toBe('false');
  });
});

describe('a finishes Link in the detail pane', () => {
  it('shows the Linear issue a pull request finishes, and can be removed for good', async () => {
    store.saveFromSource({
      source: 'linear',
      account: 'linear:org-acme',
      items: [{ externalId: 'lin-ENG-412', kind: 'linear-issue', title: 'Webhook retries' }],
    });
    const linear = store.query({ kinds: ['linear-issue'] })[0]?.id ?? '';
    const dark = store.query({ titleContains: 'Dark mode' })[0]?.id ?? '';
    store.link(
      { from: dark, linkType: 'finishes', to: linear },
      { by: { kind: 'source', source: 'github', account: GITHUB }, why: 'acme/web#12 names ENG-412' },
    );
    renderSheet();
    await waitFor(() => expect(lines()).toHaveLength(4));
    fireEvent.click(
      within(summary()).getByRole('button', { name: 'acme/web#12 Dark mode: waiting 4 days on omar' }),
    );
    const pane = await screen.findByRole('region', { name: 'Pull request detail' });
    await waitFor(() => expect(within(pane).getByText('Webhook retries')).toBeTruthy());
    expect(within(pane).getByText('Finishes')).toBeTruthy();

    fireEvent.click(within(pane).getByRole('button', { name: 'Remove the Link: Finishes Webhook retries' }));
    await waitFor(() => expect(within(pane).queryByText('Webhook retries')).toBeNull());
    expect(store.get(dark)?.links).toEqual([]);
    expect(store.githubOversight.finishesEverMade(dark, linear)).toBe(true);
  });
});

describe('skill-managed issues in the summary (#120)', () => {
  it('shows a Progress line with its bar, only when a map or milestone moved, and opens its issues', async () => {
    const { unmount } = renderSheet();
    await waitFor(() => expect(lines()).toHaveLength(4));
    expect(within(summary()).queryByRole('region', { name: 'Progress' })).toBeNull();
    unmount();

    const mapRef = { owner: 'acme', name: 'api', number: 1, title: 'v1 map', url: '' };
    const label = (name: string) => ({ name, color: 'ededed' });
    store.saveFromSource({
      source: 'github',
      account: GITHUB,
      items: [
        issue({
          number: 1,
          title: 'v1 map',
          labels: [label('wayfinder:map')],
          createdAt: NOW - 30 * DAY,
          updatedAt: NOW - 3 * HOUR,
        }),
        issue({ number: 2, title: 'Research', parent: mapRef, createdAt: NOW - HOUR, updatedAt: NOW - HOUR }),
        issue({
          number: 3,
          title: 'Grill',
          parent: mapRef,
          createdAt: NOW - 20 * DAY,
          state: 'closed',
          stateReason: 'completed',
          closedAt: NOW - HOUR,
        }),
      ],
    });
    renderSheet();
    const progress = await within(summary()).findByRole('region', { name: 'Progress' });
    expect(within(progress).getByTestId('github-summary-line').textContent).toBe(
      'acme/api#1 v1 map: 1 of 2 decided, 1 opened and 1 closed',
    );
    const bar = within(progress).getByRole('progressbar', { name: 'acme/api#1 v1 map progress' });
    expect([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')]).toEqual(['1', '2']);

    fireEvent.click(within(progress).getByTestId('github-summary-line'));
    await waitFor(() =>
      expect(listed()).toEqual(['acme/api#2 Research', 'acme/api#1 v1 map', 'acme/api#3 Grill']),
    );
  });
});

// Ares's summary (#121), kept in the Item store as the Core keeps it.
const idOfTitle = (title: string) => store.query({ titleContains: title })[0]?.id ?? '';
function writeSummary(
  changes: Partial<GitHubSummaryDetail> = {},
  entries: Partial<Record<OversightSectionKind, GitHubSummaryEntry[]>> = {
    shipped: [
      {
        theme: 'Webhooks',
        text: 'Webhook retries and session caching both landed.',
        itemIds: [idOfTitle('Retry webhooks'), idOfTitle('Cache sessions')],
        plain: false,
      },
    ],
  },
  title = 'GitHub summary · since yesterday',
): string {
  const detail: GitHubSummaryDetail = {
    kind: 'github-summary',
    cadence: 'daily',
    day: '2026-10-04',
    range: { from: NOW - DAY - 8 * HOUR, to: NOW - 8 * HOUR },
    choice: null,
    writtenAt: NOW - 8 * HOUR,
    sections: Object.entries(entries).map(([kind, list]) => ({
      kind: kind as OversightSectionKind,
      groups: [{ project: null, repos: [{ repo: API, entries: list ?? [] }] }],
    })),
    onFire: [],
    counts: { shipped: 2, started: 0, stuck: 0, onFire: 0 },
    seenAt: null,
    ...changes,
  };
  return store.record(
    { type: 'create', item: { kind: 'github-summary', title, detail } },
    { by: { kind: 'ares' } },
  ).itemId;
}
const aresEntries = () =>
  within(summary())
    .queryAllByTestId('github-summary-entry')
    .map((entry) => entry.textContent);

describe('Ares’s summary', () => {
  it('replaces the plain one when he wrote today’s, each entry opening its Items, and is marked seen', async () => {
    const id = writeSummary();
    renderSheet();
    await waitFor(() =>
      expect(within(summary()).getByTestId('github-summary-by').textContent).toBe(
        'Written by Ares 07:00 · since yesterday',
      ),
    );
    expect(lines()).toEqual([]);
    expect(aresEntries()).toEqual(['Webhooks: Webhook retries and session caching both landed.Open 2']);
    expect(within(summary()).getByTestId('github-summary-closing').textContent).toBe('Nothing on fire');
    await waitFor(() => expect(store.get(id)?.item.detail).toMatchObject({ seenAt: NOW }));

    fireEvent.click(within(summary()).getByRole('button', { name: /^Open: Webhooks/ }));
    await waitFor(() =>
      expect(listed()).toEqual(['acme/api#41 Retry webhooks', 'acme/api#42 Cache sessions']),
    );
  });

  it('isn’t shown for another range, where the plain one is', async () => {
    writeSummary();
    renderSheet();
    await waitFor(() => expect(aresEntries()).toHaveLength(1));
    fireEvent.click(within(summary()).getByRole('button', { name: 'This week' }));
    await waitFor(() => expect(lines()[0]).toBe('acme/api: 3 PRs merged'));
    expect(aresEntries()).toEqual([]);
  });

  it('shows the plain summary, saying so, when the model failed', async () => {
    store.agent.saveJob(WRITE_GITHUB_SUMMARY, {
      lastRunAt: NOW - HOUR,
      lastOutcome: 'failed',
      lastProblem: 'Z.ai is down',
    });
    renderSheet();
    await waitFor(() =>
      expect(within(summary()).getByTestId('github-summary-note').textContent).toBe(
        'Ares couldn’t write it: Z.ai is down These are the plain facts.',
      ),
    );
    expect(lines()).toHaveLength(4);
  });

  it('writes one when asked, for the range and Project shown', async () => {
    const asked: unknown[] = [];
    const oversight: OversightClient = {
      ...oversightIn(client),
      async ask(range, scope, choice) {
        asked.push({ scope, choice, to: range.to });
        const id = writeSummary(
          { cadence: 'on-demand', choice, range, writtenAt: NOW },
          {
            stuck: [
              {
                theme: null,
                text: 'Dark mode waits on Omar.',
                itemIds: [idOfTitle('Dark mode')],
                plain: false,
              },
            ],
          },
          'GitHub summary · this week',
        );
        return { summary: store.get(id)?.item ?? null, problem: null };
      },
    };
    renderSheet(oversight);
    await waitFor(() => expect(lines()).toHaveLength(4));
    fireEvent.click(within(summary()).getByRole('button', { name: 'This week' }));
    fireEvent.click(within(summary()).getByRole('button', { name: 'Ask Ares to write it' }));
    await waitFor(() => expect(aresEntries()).toEqual(['Dark mode waits on Omar.Open']));
    expect(asked).toEqual([{ scope: 'everything', choice: { kind: 'this-week' }, to: NOW }]);
    expect(within(summary()).getByTestId('github-summary-by').textContent).toBe(
      'Written by Ares 15:00 · this week',
    );
  });

  it('says why when asking comes to nothing, over the plain summary', async () => {
    renderSheet({
      ...oversightIn(client),
      ask: async () => ({ summary: null, problem: 'Ares is over this month’s model spending cap.' }),
    });
    await waitFor(() => expect(lines()).toHaveLength(4));
    fireEvent.click(within(summary()).getByRole('button', { name: 'Ask Ares to write it' }));
    await waitFor(() =>
      expect(within(summary()).getByTestId('github-summary-note').textContent).toBe(
        'Ares is over this month’s model spending cap. These are the plain facts.',
      ),
    );
  });

  it('reopens earlier summaries from Past summaries', async () => {
    writeSummary(
      {
        cadence: 'weekly',
        day: '2026-09-28',
        range: { from: NOW - 13 * DAY, to: NOW - 6 * DAY },
        writtenAt: NOW - 6 * DAY,
      },
      {
        shipped: [
          { theme: null, text: 'Last week’s work.', itemIds: [idOfTitle('Older merge')], plain: false },
        ],
      },
      'GitHub roll-up · week of 21 Sep',
    );
    writeSummary();
    renderSheet();
    await waitFor(() => expect(aresEntries()).toHaveLength(1));
    fireEvent.click(within(summary()).getByRole('button', { name: 'Past summaries' }));
    const history = within(summary()).getByRole('list', { name: 'Past summaries' });
    expect(
      within(history)
        .getAllByRole('button')
        .map((row) => row.textContent),
    ).toEqual([
      'GitHub summary · since yesterday07:00',
      'GitHub roll-up · week of 21 Sep' + 'Mon 28 Sep 15:00',
    ]);
    fireEvent.click(within(history).getByRole('button', { name: /roll-up/ }));
    await waitFor(() => expect(aresEntries()).toEqual(['Last week’s work.Open']));
    expect(within(summary()).getByTestId('github-summary-by').textContent).toBe(
      'Written by Ares Mon 28 Sep 15:00 · roll-up · week of 21 Sep',
    );
    fireEvent.click(within(summary()).getByRole('button', { name: 'Back to the pickers' }));
    await waitFor(() =>
      expect(aresEntries()).toEqual(['Webhooks: Webhook retries and session caching both landed.Open 2']),
    );
  });

  it('opens at the summary the Dashboard or the Update asks for', async () => {
    const id = writeSummary(
      {
        cadence: 'weekly',
        day: '2026-09-28',
        range: { from: NOW - 13 * DAY, to: NOW - 6 * DAY },
        writtenAt: NOW - 6 * DAY,
      },
      {
        shipped: [
          { theme: null, text: 'Last week’s work.', itemIds: [idOfTitle('Older merge')], plain: false },
        ],
      },
      'GitHub roll-up · week of 21 Sep',
    );
    localStorage.setItem('commander.github.summary.open', 'false');
    renderSheet();
    await act(async () => {});
    const { requestReveal } = await import('../../frame/reveal');
    act(() => requestReveal('github', id));
    await waitFor(() => expect(aresEntries()).toEqual(['Last week’s work.Open']));
    await waitFor(() => expect(store.get(id)?.item.detail).toMatchObject({ seenAt: NOW }));
  });
});
