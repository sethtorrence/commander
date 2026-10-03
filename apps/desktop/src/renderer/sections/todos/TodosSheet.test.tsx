// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openTestItemStore } from '../../item-store/test-item-store';
import { ProjectsProvider } from '../../projects/context';
import { type ProjectsClient, projectsIn } from '../../projects/projects';
import { ShortcutProvider, ShortcutScope, useActiveScopes, useShortcutList } from '../../shortcuts/react';
import { FrameControlsProvider, SectionProvider } from '../section';
import { todos as definition } from '.';
import { TodosSheet } from './TodosSheet';
import { type Todos, todosIn } from './todos';

let store: ItemStore;
let todos: Todos;
let projects: ProjectsClient;
let close: () => void;
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };

beforeEach(() => {
  const opened = openTestItemStore();
  ({ store, close } = opened);
  todos = todosIn(opened.client);
  projects = projectsIn(opened.client);
  localStorage.clear();
  controls.openSection.mockReset();
  controls.setTabCount.mockReset();
  // jsdom has no layout, so nothing scrolls.
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  close();
});

function Active({ children }: { children: ReactNode }) {
  useActiveScopes(['todos']);
  return children;
}

const place = { definition, number: 3, total: 8, active: true };

function renderSheet() {
  return render(
    <ShortcutProvider>
      <ProjectsProvider client={projects} storage={localStorage}>
        <FrameControlsProvider value={controls}>
          <SectionProvider place={place}>
            <ShortcutScope scope="todos" group="Todos">
              <Active>
                <TodosSheet todos={todos} />
              </Active>
            </ShortcutScope>
          </SectionProvider>
        </FrameControlsProvider>
      </ProjectsProvider>
    </ShortcutProvider>,
  );
}

const press = (key: string, target: Element = document.body, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(target, { key, ...init });
  });

const newTodo = () => screen.getByRole('textbox', { name: 'New Todo' });
const detail = () => screen.queryByRole('region', { name: 'Todo detail' });
const openGroup = () => screen.getByRole('region', { name: 'Open' });
const rows = (group: HTMLElement) =>
  within(group)
    .queryAllByRole('listitem')
    .map((row) => row.textContent);

async function addTodo(title: string) {
  fireEvent.change(newTodo(), { target: { value: title } });
  await press('Enter', newTodo());
  await waitFor(() => expect(within(openGroup()).getByText(title)).toBeTruthy());
}

describe('the Todos sheet', () => {
  it('opens the selected Todo in the detail pane with Enter and closes it with Esc', async () => {
    renderSheet();
    await addTodo('Book the dentist');
    expect(detail()).toBeNull();

    await press('Enter');
    expect(within(detail() as HTMLElement).getByRole('textbox', { name: 'Title' })).toHaveProperty(
      'value',
      'Book the dentist',
    );

    await press('Escape');
    expect(detail()).toBeNull();
  });

  it('doesn’t move, open or close while typing in the add field or the title field', async () => {
    renderSheet();
    await addTodo('First');
    await addTodo('Second');
    const selected = () =>
      within(openGroup())
        .getAllByRole('listitem')
        .find((row) => row.ariaCurrent);

    for (const key of ['j', 'k', 'Enter']) await press(key, newTodo());
    expect(selected()?.textContent).toContain('Second');
    expect(detail()).toBeNull();

    await press('Enter');
    const title = within(detail() as HTMLElement).getByRole('textbox', { name: 'Title' });
    for (const key of ['j', 'k', 'x', 'Delete']) await press(key, title);
    await press('Escape', title);
    expect(detail()).not.toBeNull();
    expect(selected()?.textContent).toContain('Second');
  });

  it('saves an edited title, shows it in the activity log, and undo restores it', async () => {
    renderSheet();
    await addTodo('Book the dentist');
    await press('Enter');
    const pane = detail() as HTMLElement;
    const title = within(pane).getByRole('textbox', { name: 'Title' });

    fireEvent.change(title, { target: { value: 'Book the dentist for Tuesday' } });
    await press('Enter', title);

    await waitFor(() => expect(rows(openGroup())[0]).toContain('Book the dentist for Tuesday'));
    const activity = within(pane).getByRole('region', { name: 'Activity' });
    await waitFor(() =>
      expect(within(activity).getAllByRole('listitem')[0]?.textContent).toMatch(/^Title changed by you/),
    );

    await press('z', document.body, { ctrlKey: true });
    await waitFor(() => expect(rows(openGroup())[0]).toContain('Book the dentist'));
    expect(rows(openGroup())[0]).not.toContain('Tuesday');
  });

  it('Esc in the title field puts the title back', async () => {
    renderSheet();
    await addTodo('Book the dentist');
    await press('Enter');
    const title = within(detail() as HTMLElement).getByRole('textbox', { name: 'Title' });

    fireEvent.change(title, { target: { value: 'Something else' } });
    await press('Escape', title);

    expect(title).toHaveProperty('value', 'Book the dentist');
  });

  it('ticks a Todo into the collapsed Done group, and unticking returns it', async () => {
    renderSheet();
    await addTodo('Renew passport');

    await press('x');
    const done = screen.getByRole('region', { name: 'Done' });
    await waitFor(() =>
      expect(within(done).getByRole('button', { name: /Done/ }).textContent).toContain('01'),
    );
    expect(rows(openGroup())).not.toContain(expect.stringContaining('Renew passport'));
    expect(within(done).queryAllByRole('listitem')).toEqual([]);

    // The Done group opens to show it, and unticking returns it to the open list.
    fireEvent.click(within(done).getByRole('button', { name: /Done/ }));
    fireEvent.click(within(done).getByRole('checkbox', { name: 'Renew passport' }));
    await waitFor(() => expect(rows(openGroup())[0]).toContain('Renew passport'));
  });

  it('deletes the selected Todo with Delete, and undo brings it back', async () => {
    renderSheet();
    await addTodo('Renew passport');

    await press('Delete');
    await waitFor(() => expect(within(openGroup()).queryAllByRole('listitem')).toEqual([]));

    await press('z', document.body, { ctrlKey: true });
    await waitFor(() => expect(rows(openGroup())[0]).toContain('Renew passport'));
  });

  it('shows each row’s origin, and the origin in the detail pane', async () => {
    renderSheet();
    await addTodo('Renew passport');

    expect(rows(openGroup())[0]).toContain('Manual');
    await press('Enter');
    expect(within(detail() as HTMLElement).getByText('Origin').nextSibling?.textContent).toBe('Manual');
  });

  it('lists the Todo’s Links both ways, and a Link to another Todo jumps to it', async () => {
    renderSheet();
    await addTodo('Prep for the Acme call');
    await addTodo('Send the deck');
    const [prep, deck] = await todos.list();
    const {
      created: [emailId],
    } = store.saveFromSource({
      source: 'gmail',
      account: 'me@example.com',
      items: [{ externalId: 'm1', kind: 'email', title: 'Contract redlines, v3' }],
    });
    store.link({ from: prep?.id ?? '', linkType: 'made-from', to: emailId ?? '' }, { by: { kind: 'user' } });
    store.link({ from: deck?.id ?? '', linkType: 'caused-by', to: prep?.id ?? '' }, { by: { kind: 'user' } });

    fireEvent.click(within(openGroup()).getByText('Prep for the Acme call'));
    const links = within(detail() as HTMLElement).getByRole('region', { name: 'Links' });
    await waitFor(() =>
      expect(
        within(links)
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual([
        expect.stringMatching(/Made from.*Contract redlines, v3/),
        expect.stringMatching(/Led to.*Send the deck/),
      ]),
    );

    fireEvent.click(within(links).getByRole('button', { name: /Send the deck/ }));
    await waitFor(() =>
      expect(within(detail() as HTMLElement).getByRole('textbox', { name: 'Title' })).toHaveProperty(
        'value',
        'Send the deck',
      ),
    );

    // A Link to an Item in another Section opens that Section.
    fireEvent.click(within(openGroup()).getByText('Prep for the Acme call'));
    await waitFor(() => expect(within(links).getAllByRole('button')).toHaveLength(2));
    fireEvent.click(within(detail() as HTMLElement).getByRole('button', { name: /Contract redlines/ }));
    expect(controls.openSection).toHaveBeenCalledWith('email');
  });

  it('puts the open-Todo count on the tab, keeping it up to date', async () => {
    renderSheet();
    await addTodo('First');
    await addTodo('Second');
    await waitFor(() => expect(controls.setTabCount).toHaveBeenLastCalledWith('todos', 2));

    await press('x');
    await waitFor(() => expect(controls.setTabCount).toHaveBeenLastCalledWith('todos', 1));
  });

  it('lists its keys in the cheat sheet', () => {
    let listed: string[] = [];
    function Listed() {
      listed = useShortcutList()
        .filter((shortcut) => shortcut.group === 'Todos')
        .map((shortcut) => `${shortcut.keys.join('+')} ${shortcut.label}`);
      return null;
    }
    render(
      <ShortcutProvider>
        <ProjectsProvider client={projects} storage={localStorage}>
          <SectionProvider place={place}>
            <ShortcutScope scope="todos" group="Todos">
              <TodosSheet todos={todos} />
            </ShortcutScope>
          </SectionProvider>
        </ProjectsProvider>
        <Listed />
      </ShortcutProvider>,
    );

    expect(listed).toEqual(
      expect.arrayContaining([
        'J Next Todo',
        'K Previous Todo',
        'Enter Open the Todo',
        'Escape Close the Todo',
        'X Tick or untick',
        'Delete Delete the Todo',
        'B File under a Project',
      ]),
    );
  });
});

describe('Projects in the Todos sheet', () => {
  const create = (name: string, code: string, accent: string) =>
    store.changeProject({ type: 'create', project: { name, code, accent } });
  const row = (title: string) =>
    within(openGroup())
      .getAllByRole('listitem')
      .find((item) => item.textContent?.includes(title)) as HTMLElement;
  const bar = () => screen.getByRole('group', { name: 'Project filter' });
  const picker = () => screen.queryByRole('dialog', { name: 'Badge picker' });

  it('shows each row’s Badge, or a faint — when Unfiled, and the Project in the detail pane', async () => {
    const lt = create('Longtail', 'LT', 'blue');
    await todos.add('Ship the beta', { projectId: lt.id, filedBy: 'user' });
    await todos.add('Call the bank');
    renderSheet();

    await waitFor(() =>
      expect(within(row('Ship the beta')).getByRole('img', { name: 'Longtail' })).toBeTruthy(),
    );
    expect(within(row('Call the bank')).getByRole('img', { name: 'Unfiled' }).textContent).toBe('—');

    fireEvent.click(within(openGroup()).getByText('Ship the beta'));
    expect(within(detail() as HTMLElement).getByText('Longtail')).toBeTruthy();
  });

  it('files the selected Todo with b, records it, and undo reverts it', async () => {
    const lt = create('Longtail', 'LT', 'blue');
    create('Titanlink', 'TL', 'teal');
    renderSheet();
    await addTodo('Ship the beta');
    await waitFor(() => expect(within(bar()).getByRole('button', { name: /Titanlink/ })).toBeTruthy());

    await press('b');
    const input = within(picker() as HTMLElement).getByRole('combobox');
    fireEvent.change(input, { target: { value: 'lt' } });
    await press('Enter', input);

    await waitFor(() =>
      expect(within(row('Ship the beta')).getByRole('img', { name: 'Longtail' })).toBeTruthy(),
    );
    expect(picker()).toBeNull();
    const todo = store.query({ kinds: ['todo'] })[0];
    expect(todo?.filing).toEqual({ projectId: lt.id, filedBy: 'user' });
    await press('Enter');
    await waitFor(() =>
      expect(within(detail() as HTMLElement).getByText('Filed under LT by you')).toBeTruthy(),
    );

    await press('z', document.body, { ctrlKey: true });
    await waitFor(() => expect(store.query({ kinds: ['todo'] })[0]?.filing).toBeNull());
  });

  it('opens the picker from a click on a row’s Badge', async () => {
    create('Longtail', 'LT', 'blue');
    renderSheet();
    await addTodo('Ship the beta');

    fireEvent.click(within(row('Ship the beta')).getByRole('button', { name: 'Project of Ship the beta' }));

    expect(picker()).not.toBeNull();
    expect(detail()).toBeNull();
  });

  it('narrows the list to the filter, with live counts of open Todos', async () => {
    const lt = create('Longtail', 'LT', 'blue');
    await todos.add('Ship the beta', { projectId: lt.id, filedBy: 'user' });
    await todos.add('Call the bank');
    renderSheet();
    await waitFor(() => expect(rows(openGroup())).toHaveLength(2));

    expect(within(bar()).getByRole('button', { name: /Everything/ }).textContent).toMatch(/02$/);
    expect(within(bar()).getByRole('button', { name: /Longtail/ }).textContent).toMatch(/01$/);
    expect(within(bar()).getByRole('button', { name: /Unfiled/ }).textContent).toMatch(/01$/);

    await press('p');
    await press('1');
    await waitFor(() => expect(rows(openGroup())).toHaveLength(1));
    expect(rows(openGroup())[0]).toContain('Ship the beta');

    fireEvent.click(within(bar()).getByRole('button', { name: /Unfiled/ }));
    await waitFor(() => expect(rows(openGroup())[0]).toContain('Call the bank'));
    expect(controls.setTabCount).toHaveBeenLastCalledWith('todos', 2);
  });

  it('files a Todo added while a Project is selected under that Project', async () => {
    const lt = create('Longtail', 'LT', 'blue');
    renderSheet();
    await waitFor(() => expect(within(bar()).getByRole('button', { name: /Longtail/ })).toBeTruthy());
    fireEvent.click(within(bar()).getByRole('button', { name: /Longtail/ }));
    await waitFor(() => expect(newTodo().getAttribute('placeholder')).toBe('New Todo in Longtail…'));

    await addTodo('Ship the beta');

    expect(store.query({ kinds: ['todo'] })[0]?.filing).toEqual({ projectId: lt.id, filedBy: 'user' });
  });
});
