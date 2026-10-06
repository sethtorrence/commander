// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { GitHubPeopleView, PersonCard, SourceItem, SummaryWriterState } from '@commander/domain';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemStoreClient } from '../../item-store/client';
import { openTestItemStore } from '../../item-store/test-item-store';
import { PeopleProvider } from '../../people/context';
import { peopleIn } from '../../people/people';
import { ProjectsProvider } from '../../projects/context';
import { FILTER_STORAGE_KEY } from '../../projects/filter';
import { type ProjectsClient, projectsIn } from '../../projects/projects';
import { ShortcutProvider, ShortcutScope } from '../../shortcuts/react';
import { FrameControlsProvider, SectionProvider } from '../section';
import { github as definition } from '.';
import { GitHubSheet } from './GitHubSheet';
import { type GitHubAccountsClient, githubWorkIn } from './github-work';
import { type PeopleViewClient, peopleViewIn } from './people';
import { GITHUB, NOW, pull } from './test-work';

// The People view (#122) in the GitHub Section: each Person's week as a card, by name and never by
// numbers, under the Section's Project filter, with Ares's paragraph and Refresh. Against a real Item
// store for the facts, and a stand-in client where only the window's behaviour is under test.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let store: ItemStore;
let client: ItemStoreClient;
let close: () => void;
let projects: ProjectsClient;
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };
const openPerson = vi.fn();
const accounts: GitHubAccountsClient = {
  list: async () => [],
  syncNow: async () => {},
  onChange: () => () => {},
};

const named = (login: string, name: string) => ({
  handle: `github:${login}`,
  name,
  email: `${login}@acme.test`,
});
const withPeople = (item: SourceItem, ...identities: ReturnType<typeof named>[]) => ({ ...item, identities });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  ({ store, client, close } = openTestItemStore());
  projects = projectsIn(client);
  localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
  openPerson.mockReset();
  controls.openSection.mockReset();
  store.saveFromSource({
    source: 'github',
    account: GITHUB,
    items: [
      withPeople(
        pull({ number: 41, title: 'Retry webhooks', state: 'merged', mergedAt: NOW - 3 * HOUR }),
        named('priya', 'Priya Raman'),
      ),
      pull({ number: 42, title: 'Back off retries', state: 'merged', mergedAt: NOW - DAY }),
      withPeople(
        pull({
          number: 43,
          title: 'Webhook signatures',
          createdAt: NOW - 12 * DAY,
          requestedReviewers: [{ kind: 'user', login: 'omar', requestedAt: NOW - 4 * DAY }],
        }),
        named('omar', 'Omar Haddad'),
      ),
      withPeople(
        pull({
          number: 44,
          title: 'Queue metrics',
          author: 'sam',
          state: 'merged',
          mergedAt: NOW - 2 * DAY,
          reviews: [{ login: 'omar', state: 'approved', submittedAt: NOW - 2 * DAY - HOUR }],
        }),
        named('sam', 'Sam Rivera'),
      ),
    ],
  });
  store.saveFromSource({
    source: 'linear',
    account: 'linear:1',
    items: [
      {
        externalId: 'ENG-412',
        kind: 'linear-issue',
        title: 'Webhooks drop events',
        detail: {
          kind: 'linear-issue',
          identifier: 'ENG-412',
          url: 'https://linear.app/acme/issue/ENG-412',
          team: { id: 'team', key: 'ENG', name: 'Engineering' },
          state: { id: 's', name: 'In Progress', type: 'started', color: '#f2c94c' },
          priority: 2,
          assignee: { id: 'u-priya', name: 'Priya Raman', displayName: 'priya', email: 'priya@acme.test' },
          creator: null,
          labels: [],
          linearProject: null,
          cycle: null,
          dueDate: null,
          estimate: null,
          description: null,
          comments: [],
          createdAt: 0,
          updatedAt: 0,
          startedAt: null,
          completedAt: null,
          canceledAt: null,
        },
      },
    ],
  });
});

afterEach(() => {
  cleanup();
  close();
  vi.useRealTimers();
});

function renderSheet(people: PeopleViewClient = peopleViewIn(client)) {
  return render(
    <ShortcutProvider>
      <PeopleProvider client={peopleIn(client)} onOpenPerson={openPerson}>
        <ProjectsProvider client={projects} storage={localStorage}>
          <FrameControlsProvider value={controls}>
            <SectionProvider place={{ definition, number: 7, total: 8, active: true }}>
              <ShortcutScope scope="github" group="GitHub">
                <GitHubSheet
                  work={githubWorkIn(client, {
                    githubDiscussion: async () => ({ ok: false, error: 'none' }),
                  })}
                  accounts={accounts}
                  people={people}
                />
              </ShortcutScope>
            </SectionProvider>
          </FrameControlsProvider>
        </ProjectsProvider>
      </PeopleProvider>
    </ShortcutProvider>,
  );
}

const openPeople = () => fireEvent.click(screen.getByRole('tab', { name: /People/ }));
const names = () => screen.queryAllByTestId('person-card').map((card) => card.getAttribute('aria-label'));
const card = (name: string) => screen.getByRole('article', { name });

describe('the People view', () => {
  it('shows each Person active this week by name, with their week from the Items', async () => {
    renderSheet();
    openPeople();
    await waitFor(() => expect(names()).toEqual(['Omar Haddad', 'Priya Raman', 'Sam Rivera']));
    expect(screen.getByRole('button', { name: 'This week' }).getAttribute('aria-pressed')).toBe('true');

    const priya = card('Priya Raman');
    expect(
      within(priya)
        .getAllByTestId('person-mark')
        .map((mark) => mark.textContent),
    ).toEqual(['PR open 12 days', '1 PR stuck']);
    // Merged expands to its pull requests.
    fireEvent.click(within(priya).getByRole('button', { name: 'Merged: 2' }));
    expect(
      within(within(priya).getByTestId('person-merged'))
        .getAllByTestId('person-work')
        .map((row) => row.textContent),
    ).toEqual(['acme/api#41Retry webhooks', 'acme/api#42Back off retries']);
    expect(within(priya).getByTestId('person-open').textContent).toContain('acme/api#43Webhook signatures');
    expect(within(priya).getByTestId('person-open').textContent).toContain(
      'Stuck: waiting 4 days on Omar Haddad',
    );
    expect(within(priya).getByTestId('person-open').textContent).toContain('open 12 days');
    expect(within(priya).getByTestId('person-linear').textContent).toBe(
      'Linear issuesENG-412Webhooks drop eventsIn Progress',
    );

    const omar = card('Omar Haddad');
    expect(within(omar).getByRole('button', { name: 'Reviewed: 1' })).toBeTruthy();
    expect(within(omar).getByTestId('person-waiting').textContent).toContain('waiting 4 days');
    expect(within(omar).getByTestId('person-waiting').textContent).toContain('by Priya Raman');
    expect(
      within(omar)
        .getAllByTestId('person-mark')
        .map((mark) => mark.textContent),
    ).toEqual(['1 review waiting 4 days']);
    // No paragraph from Ares, and his writing isn't on: the facts alone.
    expect(within(priya).queryByTestId('person-paragraph')).toBeNull();
  });

  it('switches to the last 7 days, and opens a pull request in the Section, its Person’s page from the name', async () => {
    renderSheet();
    openPeople();
    await waitFor(() => expect(names()).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Last 7 days' }).getAttribute('aria-pressed')).toBe('true'),
    );

    fireEvent.click(within(card('Priya Raman')).getByRole('button', { name: 'Priya Raman' }));
    const priya = store.people.list().find((each) => each.name === 'Priya Raman');
    expect(openPerson).toHaveBeenCalledWith(priya?.id);

    fireEvent.click(within(card('Priya Raman')).getByTitle('Open acme/api#43'));
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'Pull request detail' })).getByRole('heading', {
          name: 'Webhook signatures',
        }),
      ).toBeTruthy(),
    );
    expect(screen.queryByTestId('github-people')).toBeNull();
  });

  it('keeps to the Project filter, leaving out People with nothing in that Project', async () => {
    const titanlink = await projects.create({ name: 'Titanlink', code: 'TL', accent: 'blue' });
    const retry = store.query({ titleContains: 'Retry webhooks' })[0];
    store.record(
      {
        type: 'update',
        itemId: retry?.id ?? '',
        changes: { filing: { projectId: titanlink.id, filedBy: 'user' } },
      },
      { by: { kind: 'user' } },
    );
    localStorage.setItem(FILTER_STORAGE_KEY, titanlink.id);
    renderSheet();
    openPeople();
    await waitFor(() => expect(names()).toEqual(['Priya Raman']));
    expect(within(card('Priya Raman')).getByRole('button', { name: 'Merged: 1' })).toBeTruthy();
    expect(within(card('Priya Raman')).getByLabelText('Open PRs: 0')).toBeTruthy();
  });
});

// A stand-in for the Core: cards as given, and Refresh as asked.
const WRITING: SummaryWriterState = {
  enabled: true,
  off: false,
  lastRunAt: null,
  lastOutcome: 'ok',
  lastProblem: null,
};
function cardFor(name: string, merged: number, changes: Partial<PersonCard> = {}): PersonCard {
  return {
    key: `person-${name}`,
    personId: `person-${name}`,
    name,
    isUser: false,
    logins: [name.toLowerCase()],
    merged: Array.from({ length: merged }, (_, n) => ({
      itemId: `${name}-${n}`,
      identifier: `acme/api#${n + 1}`,
      title: `Change ${n + 1}`,
      at: NOW - HOUR,
    })),
    reviewed: [],
    opened: [],
    open: [],
    waiting: [],
    linear: [],
    marks: [],
    paragraph: null,
    ...changes,
  };
}
function standIn(view: Partial<GitHubPeopleView>, refresh?: PeopleViewClient['refresh']): PeopleViewClient {
  const full: GitHubPeopleView = {
    range: { from: NOW - 7 * DAY, to: NOW },
    cards: [],
    writer: WRITING,
    ...view,
  };
  return { week: async () => full, person: async () => full, ...(refresh && { refresh }) };
}

describe('never ranked', () => {
  it('orders cards by name, whatever their counts or the order they come in', async () => {
    renderSheet(
      standIn({ cards: [cardFor('Zed', 9), cardFor('amy', 0), cardFor('Mia', 4), cardFor('Ålvar', 1)] }),
    );
    openPeople();
    await waitFor(() => expect(names()).toEqual(['Ålvar', 'amy', 'Mia', 'Zed']));
    // Nothing reads as a score: no rank, top or leaderboard anywhere in the view.
    expect(screen.getByTestId('github-people').textContent).not.toMatch(/\b(rank|top|leader|#1\b)/i);
  });
});

describe('Ares’s paragraph', () => {
  const paragraph = {
    personId: 'person-Priya',
    name: 'Priya',
    text: 'Priya spent the week on webhook retries. Two PRs merged.',
    itemIds: ['Priya-0'],
    range: { from: new Date(2026, 8, 28).getTime(), to: NOW - 2 * HOUR },
    writtenAt: NOW - 2 * HOUR,
  };

  it('shows his paragraph through AresText with when he wrote it, and Refresh writes it again', async () => {
    const refresh = vi.fn(async () => ({
      paragraph: { ...paragraph, text: 'Priya is waiting on Omar’s review.', writtenAt: NOW },
      problem: null,
    }));
    renderSheet(standIn({ cards: [cardFor('Priya', 2, { paragraph })] }, refresh));
    openPeople();
    const text = await screen.findByTestId('person-paragraph-text');
    expect(text.textContent).toBe('Priya spent the week on webhook retries. Two PRs merged.');
    expect(screen.getByTestId('person-paragraph-by').textContent).toMatch(
      /^Written by Ares \d\d:\d\d · 28 Sep to /,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh Ares’s paragraph about Priya' }));
    });
    expect(refresh).toHaveBeenCalledWith('person-Priya', expect.objectContaining({ to: NOW }));
    await waitFor(() =>
      expect(screen.getByTestId('person-paragraph-text').textContent).toBe(
        'Priya is waiting on Omar’s review.',
      ),
    );
  });

  it('says why when Refresh writes nothing', async () => {
    const refresh = vi.fn(async () => ({
      paragraph: null,
      problem: 'Ares is over this month’s model spending cap.',
    }));
    renderSheet(standIn({ cards: [cardFor('Priya', 2, { paragraph })] }, refresh));
    openPeople();
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh Ares’s paragraph about Priya' }));
    expect((await screen.findByTestId('person-paragraph-problem')).textContent).toBe(
      'Ares is over this month’s model spending cap.',
    );
    expect(screen.getByTestId('person-paragraph-text').textContent).toContain('webhook retries');
  });

  it('with the model off, a card shows its facts alone: no paragraph, no Refresh', async () => {
    renderSheet(standIn({ cards: [cardFor('Priya', 2)], writer: { ...WRITING, off: true } }, vi.fn()));
    openPeople();
    await waitFor(() => expect(names()).toEqual(['Priya']));
    expect(screen.queryByTestId('person-paragraph')).toBeNull();
    expect(screen.queryByRole('button', { name: /Refresh/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Merged: 2' })).toBeTruthy();
  });
});
