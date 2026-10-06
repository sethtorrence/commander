// @vitest-environment jsdom

import { FAKE_MODEL, fakeEmbedding } from '@commander/core/src/meaning/fake';
import type { ActivityEntry, Project, SearchQuery } from '@commander/domain';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openTestItemStore } from '../item-store/test-item-store';
import { ProjectsProvider } from '../projects/context';
import type { ProjectsClient } from '../projects/projects';
import { ShortcutProvider } from '../shortcuts/react';
import { Palette, type PaletteProps } from './Palette';
import type { PaletteAction } from './rows';

// The palette against a real Item store on a temporary database, searched through the same request
// handling the Core uses for the window.

const user = { by: { kind: 'user' as const } };
const longtail: Project = {
  id: 'p-lt',
  name: 'Longtail',
  code: 'LT',
  accent: 'blue',
  order: 0,
  archived: false,
  createdAt: 0,
};
const projectsClient: ProjectsClient = {
  list: async () => [longtail],
  create: vi.fn(),
  change: vi.fn(),
  file: vi.fn(async () => ({}) as ActivityEntry),
  settleFiling: vi.fn(async () => null),
};

let backing: ReturnType<typeof openTestItemStore>;
let searches: SearchQuery[];

beforeEach(() => {
  backing = openTestItemStore();
  searches = [];
});

afterEach(() => {
  cleanup();
  backing.close();
});

function renderPalette(overrides: Partial<PaletteProps> = {}) {
  const onAction = vi.fn<(action: PaletteAction) => void>();
  const onOpenChange = vi.fn();
  const switchTheme = vi.fn();
  render(
    <ShortcutProvider>
      <ProjectsProvider client={projectsClient} storage={localStorage}>
        <Palette
          open
          onOpenChange={onOpenChange}
          initial=""
          mode="jump"
          search={(query) => {
            searches.push(query);
            return backing.client({ op: 'search', query });
          }}
          sections={[
            { id: 'dashboard', label: 'Dashboard', code: 'DSH' },
            { id: 'notes', label: 'Notes', code: 'DN' },
            { id: 'todos', label: 'Todos', code: 'TDO' },
            { id: 'linear', label: 'Linear', code: 'LIN' },
          ]}
          current="dashboard"
          projects={[longtail]}
          commands={() => [{ label: 'Switch theme', run: switchTheme }]}
          accounts={[{ id: 'linear:org-acme', name: 'Acme', source: 'linear', urlKey: 'acme' }]}
          now={new Date(2026, 9, 3, 10)}
          today="2026-10-03"
          onAction={onAction}
          {...overrides}
        />
      </ProjectsProvider>
    </ShortcutProvider>,
  );
  return { onAction, onOpenChange, switchTheme };
}

const input = () => screen.getByRole('combobox', { name: 'Search Commander' });
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const press = (key: string) => fireEvent.keyDown(input(), { key });
const selected = () => screen.getByRole('option', { selected: true });

describe('the palette', () => {
  it('opens on Jump, Projects and Commands, with the first row selected', () => {
    renderPalette();
    expect(screen.getAllByRole('group').map((group) => group.getAttribute('aria-label'))).toEqual([
      'Jump',
      'Projects',
      'Commands',
    ]);
    expect(selected().textContent).toContain('Dashboard');
    expect(document.activeElement).toBe(input());
  });

  it('finds Items as the User types, grouped, and Enter opens the selected one', async () => {
    const todo = backing.store.record(
      { type: 'create', item: { kind: 'todo', title: 'Renew the passport' } },
      user,
    );
    const { onAction, onOpenChange } = renderPalette();
    type('passp');
    const todos = await screen.findByRole('group', { name: 'Todos' });
    expect(within(todos).getByRole('option').textContent).toContain('Renew the passport');
    expect(selected().textContent).toContain('Renew the passport');
    press('Enter');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'item',
        hit: expect.objectContaining({ item: expect.objectContaining({ id: todo.itemId }) }),
      }),
    );
  });

  it('moves with the arrows, wrapping around, and runs a command', async () => {
    const { onAction } = renderPalette();
    type('switch');
    await waitFor(() => expect(selected().textContent).toContain('Switch theme'));
    press('ArrowDown');
    expect(selected().textContent).toContain('Search “switch” in Linear');
    press('ArrowDown');
    expect(selected().textContent).toContain('Switch theme');
    press('ArrowUp');
    press('ArrowUp');
    expect(selected().textContent).toContain('Switch theme');
    press('Enter');
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'command' }));
  });

  it('acts on the latest results when Enter comes before they arrive', async () => {
    backing.store.saveFromSource({
      source: 'linear',
      account: 'linear:org-acme',
      items: [
        {
          externalId: 'issue-418',
          kind: 'linear-issue',
          title: 'Fix the login loop',
          detail: {
            kind: 'linear-issue',
            identifier: 'ENG-418',
            url: 'https://linear.app/acme/issue/ENG-418',
            team: { id: 't', key: 'ENG', name: 'Engineering' },
            state: { id: 's', name: 'Todo', type: 'unstarted', color: '#999999' },
            priority: 0,
            assignee: null,
            creator: null,
            labels: [],
            cycle: null,
            linearProject: null,
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
    const { onAction } = renderPalette();
    type('ENG-418');
    press('Enter');
    await waitFor(() => expect(onAction).toHaveBeenCalled());
    expect(onAction.mock.calls[0]?.[0]).toMatchObject({
      type: 'item',
      hit: { item: { title: 'Fix the login loop' }, exact: true },
    });
  });

  it('sends chips as filters, and picks them from the filter row', async () => {
    renderPalette({ initial: 'in:todos #LT ', mode: 'find' });
    expect(screen.getByText('Find')).toBeTruthy();
    const filters = screen.getByTestId('palette-filters');
    expect(within(filters).getByRole('button', { name: 'Todos' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(filters).getByRole('button', { name: 'LT' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Type to search.')).toBeTruthy();

    type('in:todos #LT invoice');
    await waitFor(() =>
      expect(searches.at(-1)).toEqual({ text: 'invoice', kinds: ['todo'], projectId: 'p-lt' }),
    );
    fireEvent.click(within(filters).getByRole('button', { name: 'Linear' }));
    expect((input() as HTMLInputElement).value).toBe('in:linear in:todos #LT invoice');
    fireEvent.click(within(filters).getByRole('button', { name: 'Todos' }));
    expect((input() as HTMLInputElement).value).toBe('in:linear #LT invoice');
  });

  it('shows word results at once, then merges in what search by meaning finds, marked related (#73)', async () => {
    backing.store.record({ type: 'create', item: { kind: 'todo', title: 'Throttle bursts on /sync' } }, user);
    backing.store.record({ type: 'create', item: { kind: 'todo', title: 'Rate the coffee' } }, user);
    // Embedded as the Core's meaning side would, by the stand-in model.
    const work = backing.store.meaning.pending(FAKE_MODEL.id, 10);
    backing.store.meaning.save(
      FAKE_MODEL.id,
      work.map((each) => ({ ...each, vector: fakeEmbedding(each.text) })),
    );
    let answerMeaning: () => void = () => {};
    const meaningAsked: SearchQuery[] = [];
    renderPalette({
      searchByMeaning: (query) => {
        meaningAsked.push(query);
        return new Promise((resolve) => {
          answerMeaning = () =>
            resolve(
              backing.store.search.query(query, {
                model: FAKE_MODEL.id,
                vector: fakeEmbedding(query.text),
                minSimilarity: 0.5,
              }),
            );
        });
      },
    });
    type('rate ');
    const todos = await screen.findByRole('group', { name: 'Todos' });
    expect(
      within(todos)
        .getAllByRole('option')
        .map((row) => row.textContent),
    ).toEqual([expect.stringContaining('Rate the coffee')]);

    await waitFor(() => expect(meaningAsked).toEqual([{ text: 'rate ' }]));
    answerMeaning();
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /Throttle bursts on \/sync/ }).textContent).toContain(
        'Related',
      ),
    );
    expect(screen.getByRole('option', { name: /Rate the coffee/ }).textContent).not.toContain('Related');
  });

  it('keeps the word results when search by meaning has nothing to add', async () => {
    backing.store.record({ type: 'create', item: { kind: 'todo', title: 'Renew the passport' } }, user);
    renderPalette({ searchByMeaning: async () => null });
    type('passport');
    const todos = await screen.findByRole('group', { name: 'Todos' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(
      within(todos)
        .getAllByRole('option')
        .map((row) => row.textContent),
    ).toEqual([expect.stringContaining('Renew the passport')]);
  });

  it('opens Linear’s own search when local results are thin', async () => {
    const { onAction } = renderPalette();
    type('okta');
    const row = await screen.findByRole('option', { name: /Search “okta” in Linear/ });
    fireEvent.click(row);
    expect(onAction).toHaveBeenCalledWith({ type: 'browser', url: 'https://linear.app/acme/search?q=okta' });
  });
});
