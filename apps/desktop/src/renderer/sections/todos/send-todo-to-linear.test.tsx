// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { Item, LinearIssueDetail } from '@commander/domain';
import type { AccountSummary } from '@commander/domain/ipc';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// Send to Linear from the Todos Section: `l` (or the detail pane's Send to Linear, or the palette)
// opens the dialog on the selected Todo; sending backs the Todo by the new issue, so it shows the
// Linear origin and ticking it completes the issue; Ctrl+Z undoes the send.

const ACME = 'linear:org-acme';
const ME = { id: 'user-me', name: 'Sam Rivera', displayName: 'sam', email: null };
const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' };
const STATES = {
  todo: { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
  done: { id: 'state-done', name: 'Done', type: 'completed', color: '#5e6ad2' },
};
const acme: AccountSummary = {
  id: ACME,
  source: 'linear',
  name: 'Acme',
  urlKey: 'acme',
  method: 'api-key',
  status: 'connected',
  user: { id: ME.id, name: ME.name },
  sync: null,
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
  // The window's bridge, as far as Send to Linear reaches it.
  Object.assign(window, {
    commander: {
      itemStore: opened.client,
      accounts: async () => ({ ok: true, state: { accounts: [acme], linearOAuth: false } }),
      onAccountsChanged: () => () => {},
    },
  });
  localStorage.clear();
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
  store.saveFromSource({ source: 'linear', account: ACME, me: ME.id, items: [] });
  store.record(
    {
      type: 'create',
      item: {
        kind: 'todo',
        title: 'Write the runbook',
        detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null },
      },
    },
    { by: { kind: 'user' } },
  );
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
const row = () => screen.getByRole('region', { name: 'Open' }).querySelector('li') as HTMLElement;
const todo = () => store.query({ kinds: ['todo'], includeDeleted: true })[0] as Item;
const issues = () => store.query({ kinds: ['linear-issue'], includeDeleted: true });

describe('Send to Linear in the Todos Section', () => {
  it('sends the selected Todo with l: the Todo is backed by the issue, shows Linear, and ticks through', async () => {
    renderSheet();
    await waitFor(() => expect(row().textContent).toContain('Write the runbook'));
    expect(commands.available().map((each) => each.label)).toContain('Send Todo to Linear');
    await press('l');
    const dialog = await screen.findByTestId('send-to-linear');
    expect(within(dialog).getByLabelText('Title')).toHaveProperty('value', 'Write the runbook');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Send to Linear/ }));

    await waitFor(() => expect(row().textContent).toContain('Linear · ENG-…'));
    const [issue] = issues();
    expect(todo().detail).toMatchObject({ origin: 'linear', backedBy: issue?.id });
    // A Todo backed by an issue can't be sent again.
    expect(commands.available().map((each) => each.label)).not.toContain('Send Todo to Linear');

    await press('x');
    await waitFor(() =>
      expect((issues()[0]?.detail as LinearIssueDetail | undefined)?.state.name).toBe('Done'),
    );
  });

  it('undoes the send with Ctrl+Z: the issue is deleted and the Todo is as it was', async () => {
    renderSheet();
    await waitFor(() => expect(row().textContent).toContain('Write the runbook'));
    await press('Enter');
    const pane = screen.getByRole('region', { name: 'Todo detail' });
    fireEvent.click(within(pane).getByRole('button', { name: /Send to Linear/ }));
    const dialog = await screen.findByTestId('send-to-linear');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Send to Linear/ }));
    await waitFor(() => expect(row().textContent).toContain('Linear · ENG-…'));

    await press('z', { ctrlKey: true });
    await waitFor(() => expect(issues()[0]?.deletedAt).not.toBeNull());
    expect(todo().detail).toMatchObject({ origin: 'manual', backedBy: null });
    await waitFor(() => expect(row().textContent).toContain('Manual'));
  });
});
