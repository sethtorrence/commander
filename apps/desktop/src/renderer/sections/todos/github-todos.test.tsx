// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { Item, ReviewRequestDetail } from '@commander/domain';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemChanges } from '../../item-store/changes';
import { openTestItemStore } from '../../item-store/test-item-store';
import { CommandProvider, createCommandRegistry } from '../../palette/commands';
import { ProjectsProvider } from '../../projects/context';
import { type ProjectsClient, projectsIn } from '../../projects/projects';
import { ShortcutProvider, ShortcutScope, useActiveScopes } from '../../shortcuts/react';
import { GITHUB, pull, reviewRequest } from '../github/test-work';
import { FrameControlsProvider, SectionProvider } from '../section';
import { todos as definition } from '.';
import { TodosSheet } from './TodosSheet';
import { type Todos, todosIn } from './todos';

// GitHub Todos in the Todos Section (#116): a review asked of the User, labelled as GitHub with its
// pull request; ticking completes it only in Commander (GitHub is read-only in v1), saying so; the
// detail pane offers Open in GitHub; and `b` files the pull request, which the Todo follows.

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
  Element.prototype.scrollIntoView = () => {};
  store.githubWatch.saveAccess(GITHUB, {
    via: 'token',
    login: 'octocat',
    orgs: [],
    personal: [],
    fetchedAt: Date.now(),
  });
  const request = reviewRequest(12);
  store.saveFromSource({
    source: 'github',
    account: GITHUB,
    items: [
      pull({ number: 12, title: 'Retry webhooks', requestedReviewers: [] }),
      { ...request, title: 'Retry webhooks', detail: request.detail as ReviewRequestDetail },
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

const todo = () => store.query({ kinds: ['todo'], includeDeleted: true })[0] as Item;
const pullRequest = () => store.query({ kinds: ['pull-request'] })[0] as Item;
const pane = () => screen.getByRole('region', { name: 'Todo detail' });
const row = () => screen.getByRole('region', { name: 'Open' }).querySelector('li') as HTMLElement;

describe('a GitHub Todo in the Todos Section', () => {
  it('shows the GitHub origin with its pull request', async () => {
    renderSheet();
    await waitFor(() => expect(row().textContent).toContain('GitHub · acme/api#12'));
    expect(row().textContent).toContain('Review: Retry webhooks');
  });

  it('ticks in Commander only, saying nothing changes on GitHub, and offers Open in GitHub', async () => {
    renderSheet();
    await waitFor(() => expect(row().textContent).toContain('acme/api#12'));
    await press('Enter');
    const open = within(pane()).getByRole('link', { name: /Open in GitHub/ });
    expect(open.getAttribute('href')).toBe('https://github.com/acme/api/pull/12');
    await press('x');
    await waitFor(() => expect(todo().status).toBe('done'));
    expect(store.activity({ itemId: todo().id })[0]?.why).toBe(
      'Ticked in Commander · Nothing changes on GitHub',
    );
    expect(store.outgoing.list()).toEqual([]);
  });

  it('files the pull request when filed with b, and the Todo follows it', async () => {
    const lt = await projects.create({ name: 'Longtail', code: 'LT', accent: 'blue' });
    renderSheet();
    await waitFor(() => expect(row().textContent).toContain('acme/api#12'));
    await press('b');
    const picker = await screen.findByTestId('badge-picker');
    fireEvent.click(within(picker).getByRole('option', { name: /Longtail/ }));
    await waitFor(() => expect(pullRequest().filing).toEqual({ projectId: lt.id, filedBy: 'user' }));
    expect(todo().filing).toEqual({ projectId: lt.id, filedBy: 'inherited' });
  });
});
