// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onReveal } from '../../frame/reveal';
import type { ItemChanges } from '../../item-store/changes';
import { openTestItemStore } from '../../item-store/test-item-store';
import { ProjectsProvider } from '../../projects/context';
import { type ProjectsClient, projectsIn } from '../../projects/projects';
import { ShortcutProvider, ShortcutScope, useActiveScopes } from '../../shortcuts/react';
import { FrameControlsProvider, SectionProvider } from '../section';
import { chat, message, PRIYA, TEAMS } from '../teams/test-chats';
import { todos as definition } from '.';
import { TodosSheet } from './TodosSheet';
import { type Todos, todosIn } from './todos';

// Todos Ares made from Teams Chats (#110) in the Todos Section: labelled "Ares · from Teams, <Chat>",
// and their made-from Link opens the Chat at the message they came from. A real Item store on a
// temporary database.

let store: ItemStore;
let todos: Todos;
let projects: ProjectsClient;
let changes: ItemChanges;
let close: () => void;
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };

beforeEach(() => {
  const opened = openTestItemStore();
  ({ store, close, changes } = opened);
  todos = todosIn(opened.client);
  projects = projectsIn(opened.client);
  localStorage.clear();
  controls.openSection.mockReset();
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  close();
});

// Priya asks for the rollout plan; Ares adds a Todo for it, made from her Chat at that message.
function aresTodoFromTeams() {
  const asked = message(PRIYA, 'Can you send me the rollout plan by Friday?', 60_000);
  store.saveFromSource({
    source: 'teams',
    account: TEAMS,
    items: [chat({ id: '19:priya_sam@unq.gbl.spaces', title: 'Priya Patel', messages: [asked] })],
  });
  const chatId = store.query({ kinds: ['chat'] })[0]?.id as string;
  const [todo] = store.recordAll(
    [
      {
        type: 'create',
        item: {
          kind: 'todo',
          title: 'Send Priya the rollout plan',
          detail: {
            kind: 'todo',
            origin: 'ares',
            dueOn: null,
            backedBy: null,
            fromMessage: { itemId: chatId, messageId: asked.id },
          },
        },
      },
    ],
    { by: { kind: 'ares' } },
  );
  store.link({ from: todo?.itemId as string, linkType: 'made-from', to: chatId }, { by: { kind: 'ares' } });
  return { todoId: todo?.itemId as string, chatId, messageId: asked.id };
}

function Active({ children }: { children: ReactNode }) {
  useActiveScopes(['todos']);
  return children;
}

function renderSheet() {
  return render(
    <ShortcutProvider>
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
    </ShortcutProvider>,
  );
}

const openGroup = () => screen.getByRole('region', { name: 'Open' });
const detail = () => screen.getByRole('region', { name: 'Todo detail' });

describe('an Ares Todo from Teams', () => {
  it('knows the Chat and message it was made from', async () => {
    const { todoId, chatId, messageId } = aresTodoFromTeams();
    const made = await todos.madeFrom(await todos.list());
    expect(made.get(todoId)).toEqual({ chatId, chatName: 'Priya Patel', messageId });
  });

  it('is labelled “Ares · from Teams, <Chat>”, and its Link opens the Chat at the message', async () => {
    const { chatId, messageId } = aresTodoFromTeams();
    const revealed: [string, string | undefined][] = [];
    const stop = onReveal('teams', (itemId, focus) => revealed.push([itemId, focus]));
    renderSheet();

    await waitFor(() =>
      expect(within(openGroup()).getAllByRole('listitem')[0]?.textContent).toContain(
        'Ares · from Teams, Priya Patel',
      ),
    );
    await act(() => {
      fireEvent.keyDown(document.body, { key: 'Enter' });
    });
    expect(within(detail()).getByText('Origin').nextSibling?.textContent).toBe(
      'Ares · from Teams, Priya Patel',
    );
    expect(within(detail()).getByText('Added by Ares from Teams')).toBeTruthy();

    const links = within(detail()).getByRole('region', { name: 'Links' });
    fireEvent.click(await within(links).findByRole('button', { name: /Made from.*Priya Patel/ }));
    expect(controls.openSection).toHaveBeenCalledWith('teams');
    expect(revealed).toEqual([[chatId, messageId]]);
    stop();
  });
});
