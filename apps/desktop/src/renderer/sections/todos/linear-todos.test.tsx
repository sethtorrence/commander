// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { Item, LinearIssueDetail } from '@commander/domain';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onReveal } from '../../frame/reveal';
import type { ItemChanges } from '../../item-store/changes';
import { openTestItemStore } from '../../item-store/test-item-store';
import { CommandProvider, createCommandRegistry } from '../../palette/commands';
import { ProjectsProvider } from '../../projects/context';
import { type ProjectsClient, projectsIn } from '../../projects/projects';
import { ShortcutProvider, ShortcutScope, useActiveScopes } from '../../shortcuts/react';
import { FrameControlsProvider, SectionProvider } from '../section';
import { todos as definition } from '.';
import { TodosSheet } from './TodosSheet';
import { type Todos, todosIn } from './todos';

// Linear-backed Todos in the Todos Section: labelled as Linear with the issue's identifier, ticked
// (and unticked, and undone) through to the issue, opened in the Linear Section, moved to any state
// of the issue's team with Set Linear state…, and filed by filing the issue.

const ACME = 'linear:org-acme';
const ME = { id: 'user-me', name: 'Sam Rivera', displayName: 'sam', email: null };
const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' };
const STATES = {
  todo: { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
  progress: { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' },
  review: { id: 'state-review', name: 'In Review', type: 'started', color: '#0f783c' },
  done: { id: 'state-done', name: 'Done', type: 'completed', color: '#5e6ad2' },
};

let store: ItemStore;
let todos: Todos;
let projects: ProjectsClient;
let changes: ItemChanges;
let close: () => void;
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };
const commands = createCommandRegistry();

beforeEach(() => {
  const opened = openTestItemStore();
  ({ store, close, changes } = opened);
  todos = todosIn(opened.client);
  projects = projectsIn(opened.client);
  localStorage.clear();
  controls.openSection.mockReset();
  Element.prototype.scrollIntoView = () => {};
  store.syncState.saveCatalog(
    ACME,
    'linear',
    {
      kind: 'linear',
      teams: [
        { ...ENG, states: Object.values(STATES), members: [ME], labels: [], cycles: [], linearProjects: [] },
      ],
    },
    Date.now(),
  );
  store.saveFromSource({
    source: 'linear',
    account: ACME,
    me: ME.id,
    items: [
      {
        externalId: 'issue-418',
        kind: 'linear-issue',
        title: 'Fix the login loop',
        detail: {
          kind: 'linear-issue',
          identifier: 'ENG-418',
          url: 'https://linear.app/acme/issue/ENG-418',
          team: ENG,
          state: STATES.progress,
          priority: 0,
          assignee: ME,
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
});

afterEach(() => {
  cleanup();
  close();
});

function Active({ children }: { children: ReactNode }) {
  useActiveScopes(['todos']);
  return children;
}

function renderSheet() {
  return render(
    <ShortcutProvider>
      <CommandProvider registry={commands}>
        <ProjectsProvider client={projects} storage={localStorage}>
          <FrameControlsProvider value={controls}>
            <SectionProvider place={{ definition, number: 3, total: 8, active: true }}>
              <ShortcutScope scope="todos" group="Todos">
                <Active>
                  <TodosSheet todos={todos} changes={changes} />
                </Active>
              </ShortcutScope>
            </SectionProvider>
          </FrameControlsProvider>
        </ProjectsProvider>
      </CommandProvider>
    </ShortcutProvider>,
  );
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(document.body, { key, ...init });
  });

const issue = () => store.query({ kinds: ['linear-issue'] })[0] as Item & { detail: LinearIssueDetail };
const todo = () => store.query({ kinds: ['todo'], includeDeleted: true })[0] as Item;
const pane = () => screen.getByRole('region', { name: 'Todo detail' });
const row = () => screen.getByRole('region', { name: 'Open' }).querySelector('li') as HTMLElement;

async function chooseState(name: string) {
  const picker = within(pane()).getByRole('combobox', { name: 'Set Linear state…' });
  await act(async () => {
    fireEvent.keyDown(picker, { key: 'Enter' });
  });
  const listbox = await screen.findByRole('listbox');
  await act(async () => {
    fireEvent.click(within(listbox).getByRole('option', { name }));
  });
}

describe('a Linear Todo in the Todos Section', () => {
  it('shows the Linear origin with the issue’s identifier', async () => {
    renderSheet();
    await waitFor(() => expect(row().textContent).toContain('Linear · ENG-418'));
    expect(row().textContent).toContain('Fix the login loop');
  });

  it('carries its issue’s warning mark, on its row and in its detail pane', async () => {
    store.injectionWarnings.flag(issue().id, 'Fix the login loop');
    renderSheet();
    const warning = 'This Todo’s issue contains instructions aimed at Ares. He ignored them.';
    await waitFor(() => expect(within(row()).getByRole('note', { name: warning })).toBeTruthy());
    await press('Enter');
    expect(within(pane()).getByRole('note').textContent).toContain(warning);
  });

  it('ticks through to the issue with x, and undo moves the issue back', async () => {
    renderSheet();
    await waitFor(() => expect(row().textContent).toContain('ENG-418'));
    await press('x');
    await waitFor(() => expect(issue().detail.state.name).toBe('Done'));
    expect(todo().status).toBe('done');

    await press('z', { ctrlKey: true });
    await waitFor(() => expect(issue().detail.state.name).toBe('In Progress'));
    expect(todo().status).toBe('open');
  });

  it('opens its issue in the Linear Section from the detail pane', async () => {
    const revealed: string[] = [];
    const stop = onReveal('linear', (itemId) => revealed.push(itemId));
    renderSheet();
    await waitFor(() => expect(row().textContent).toContain('ENG-418'));
    await press('Enter');
    fireEvent.click(within(pane()).getByRole('button', { name: /Open ENG-418 in the Linear Section/ }));
    expect(controls.openSection).toHaveBeenLastCalledWith('linear');
    expect(revealed).toEqual([issue().id]);
    stop();
  });

  it('moves the issue to any state of its team with Set Linear state…, undoably', async () => {
    renderSheet();
    await waitFor(() => expect(row().textContent).toContain('ENG-418'));
    await press('Enter');
    await waitFor(() => within(pane()).getByRole('combobox', { name: 'Set Linear state…' }));
    await chooseState('In Review');
    await waitFor(() => expect(issue().detail.state.name).toBe('In Review'));

    await chooseState('Done');
    await waitFor(() => expect(todo().status).toBe('done'));

    await press('z', { ctrlKey: true });
    await waitFor(() => expect(issue().detail.state.name).toBe('In Review'));
    expect(todo().status).toBe('open');
  });

  it('offers Set Linear state… in the palette while a Linear Todo is selected', async () => {
    renderSheet();
    await waitFor(() => expect(row().textContent).toContain('ENG-418'));
    const command = commands.available().find((each) => each.label === 'Set Linear state…');
    expect(command).toBeTruthy();
    act(() => command?.run());
    await screen.findByRole('listbox');
  });

  it('files the issue when filed with b, and the Todo follows it', async () => {
    const lt = await projects.create({ name: 'Longtail', code: 'LT', accent: 'blue' });
    renderSheet();
    await waitFor(() => expect(row().textContent).toContain('ENG-418'));
    await press('b');
    const picker = await screen.findByTestId('badge-picker');
    fireEvent.click(within(picker).getByRole('option', { name: /Longtail/ }));
    await waitFor(() => expect(issue().filing).toEqual({ projectId: lt.id, filedBy: 'user' }));
    expect(todo().filing).toEqual({ projectId: lt.id, filedBy: 'inherited' });
  });
});
