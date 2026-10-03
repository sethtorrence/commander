// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { FiledBy, Project } from '@commander/domain';
import { Toaster } from '@commander/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemStoreClient } from '../../item-store/client';
import { openTestItemStore } from '../../item-store/test-item-store';
import { ShortcutProvider, ShortcutScope, useActiveScopes } from '../../shortcuts/react';
import { ProjectsProvider } from '../context';
import { projectsIn } from '../projects';
import { PROJECT_PAGE_SCOPE, ProjectPage } from './ProjectPage';

// The Project page against a real Item store on a temporary database.
let store: ItemStore;
let client: ItemStoreClient;
let close: () => void;
let lt: Project;
let tx: Project;

beforeEach(() => {
  localStorage.clear();
  ({ store, client, close } = openTestItemStore());
  lt = create('Longtail', 'LT', 'blue');
  create('Titanlink', 'TL', 'teal');
  tx = create('Tactics', 'TX', 'violet');
});

afterEach(() => {
  cleanup();
  close();
});

function create(name: string, code: string, accent: string) {
  return store.changeProject({ type: 'create', project: { name, code, accent } }).project as Project;
}

function addTodo(title: string, projectId: string | null, filedBy: FiledBy = 'user') {
  return store.record(
    {
      type: 'create',
      item: {
        kind: 'todo',
        title,
        filing: projectId ? { projectId, filedBy } : null,
        detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null },
      },
    },
    { by: { kind: 'user' } },
  ).itemId;
}

function Active({ children }: { children: ReactNode }) {
  useActiveScopes([PROJECT_PAGE_SCOPE]);
  return <>{children}</>;
}

function renderPage(projectId = lt.id) {
  const onBack = vi.fn();
  const onOpenPage = vi.fn();
  const onOpenSection = vi.fn();
  const projects = projectsIn(client);
  const page = (id: string) => (
    <ShortcutProvider>
      <ProjectsProvider client={projects} storage={localStorage} onOpenPage={onOpenPage}>
        <Active>
          <ShortcutScope scope={PROJECT_PAGE_SCOPE} group="Project page">
            <ProjectPage
              projectId={id}
              active
              itemStore={client}
              back={{ label: 'Todos', onClick: onBack }}
              onOpenSection={onOpenSection}
            />
          </ShortcutScope>
        </Active>
      </ProjectsProvider>
      <Toaster />
    </ShortcutProvider>
  );
  render(page(projectId));
  return { onBack, onOpenPage, onOpenSection };
}

// Renders the page and waits for its Project and Items to load.
async function renderLoadedPage(projectId = lt.id) {
  const rendered = renderPage(projectId);
  await screen.findByRole('region', { name: 'Manage the Project' });
  return rendered;
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
const sheet = () => screen.getByTestId('project-page');
const openTodos = () => within(sheet()).getByRole('region', { name: 'Open Todos' });
const counts = () => within(sheet()).getByRole('group', { name: 'In each Section' });
const filed = () => screen.getByRole('region', { name: 'How its Items were filed' });
const manage = () => screen.getByRole('region', { name: 'Manage the Project' });
const filingRow = (label: string) =>
  within(filed()).getByText(label, { exact: true }).closest('div') as HTMLElement;

describe('the Project page', () => {
  it('shows the sheet header, per-Section counts, the open Todos and how its Items were filed', async () => {
    addTodo('Ship the beta', lt.id, 'user');
    addTodo('Book the offsite', lt.id, 'ares');
    const done = addTodo('Old task', lt.id, 'user');
    store.record({ type: 'update', itemId: done, changes: { status: 'done' } }, { by: { kind: 'user' } });
    addTodo('Elsewhere', tx.id);
    await renderLoadedPage();

    const heading = await within(sheet()).findByRole('heading', { level: 1, name: /Longtail/ });
    expect(within(heading).getByRole('img', { name: 'Longtail' }).textContent).toBe('LT');
    expect(within(sheet()).getByText(/^PRJ-LT-\d{3}$/)).toBeTruthy();
    await waitFor(() =>
      expect(within(counts()).getByRole('button', { name: /Todos/ }).textContent).toMatch(/02$/),
    );
    expect(within(counts()).getByRole('button', { name: /Notes/ }).textContent).toMatch(/00$/);
    expect(
      within(openTodos())
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual([expect.stringContaining('Ship the beta'), expect.stringContaining('Book the offsite')]);
    expect(filingRow('Set by you').textContent).toMatch(/02$/);
    expect(filingRow('Filed by Ares').textContent).toMatch(/01$/);
    expect(filingRow('By Rule').textContent).toMatch(/00$/);
    expect(filingRow('Follows its source').textContent).toMatch(/00$/);
  });

  it('ticks with x, moves with j and k, and re-files with b, like the Todos Section', async () => {
    const first = addTodo('Ship the beta', lt.id);
    const second = addTodo('Write the brief', lt.id);
    await renderLoadedPage();
    await within(openTodos()).findByText('Write the brief');

    act(() => press('j'));
    act(() => press('x'));
    await waitFor(() => expect(store.get(second)?.item.status).toBe('done'));
    await waitFor(() => expect(within(openTodos()).queryByText('Write the brief')).toBeNull());
    await waitFor(() =>
      expect(within(counts()).getByRole('button', { name: /Todos/ }).textContent).toMatch(/01$/),
    );

    act(() => press('b'));
    const picker = await screen.findByRole('dialog', { name: 'Badge picker' });
    fireEvent.change(within(picker).getByRole('combobox'), { target: { value: 'tx' } });
    fireEvent.keyDown(within(picker).getByRole('combobox'), { key: 'Enter' });
    await waitFor(() => expect(store.get(first)?.item.filing?.projectId).toBe(tx.id));
    await waitFor(() => expect(within(openTodos()).queryByText('Ship the beta')).toBeNull());
  });

  it('opens a Section scoped to the Project from its count, and goes back with Esc', async () => {
    const { onBack, onOpenSection } = await renderLoadedPage();
    await within(counts()).findByRole('button', { name: /Todos/ });

    fireEvent.click(within(counts()).getByRole('button', { name: /Todos/ }));
    expect(onOpenSection).toHaveBeenCalledWith('todos');
    expect(localStorage.getItem('commander.projects.filter')).toBe(lt.id);

    act(() => press('Escape'));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('renames and recodes the Project, refusing a code another Project has', async () => {
    addTodo('Ship the beta', lt.id);
    await renderLoadedPage();
    const form = await within(manage()).findByRole('form', { name: 'Name, code and accent' });

    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Lighthouse' } });
    fireEvent.change(within(form).getByLabelText('Badge code'), { target: { value: 'tx' } });
    fireEvent.submit(form);
    expect((await within(form).findByRole('alert')).textContent).toBe(
      'TX is already the Badge code for Tactics',
    );

    fireEvent.change(within(form).getByLabelText('Badge code'), { target: { value: 'lh' } });
    fireEvent.submit(form);
    await within(sheet()).findByRole('heading', { level: 1, name: /Lighthouse/ });
    expect(store.projects()[0]).toMatchObject({ name: 'Lighthouse', code: 'LH' });
    // Every Badge follows at once, the Todo rows' included.
    await waitFor(() =>
      expect(within(openTodos()).getByRole('img', { name: 'Lighthouse' }).textContent).toBe('LH'),
    );
  });

  it('recolours with a custom accent, warning when it is close to orange', async () => {
    await renderLoadedPage();
    const form = await within(manage()).findByRole('form', { name: 'Name, code and accent' });

    fireEvent.change(within(form).getByLabelText('Custom accent colour'), { target: { value: '#FF6A10' } });
    expect((await within(form).findByRole('alert')).textContent).toMatch(/close to orange/);
    fireEvent.change(within(form).getByLabelText('Custom accent colour'), { target: { value: '#1E1E40' } });
    await waitFor(() => expect(within(form).queryByRole('alert')).toBeNull());
    expect(within(form).getByText(/Deepened/)).toBeTruthy();
    fireEvent.submit(form);

    await waitFor(() => expect(store.projects()[0]?.accent).toBe('#1E1E40'));
  });

  it('archives the Project and unarchives it', async () => {
    await renderLoadedPage();
    fireEvent.click(await within(manage()).findByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(store.projects().map((p) => p.code)).toEqual(['TL', 'TX']));
    expect(within(sheet()).getByText(/Archived/)).toBeTruthy();

    fireEvent.click(await within(manage()).findByRole('button', { name: 'Unarchive' }));
    await waitFor(() => expect(store.projects().map((p) => p.code)).toEqual(['TL', 'TX', 'LT']));
  });

  it('merges another Project into it, moving every Item, and undoes the merge', async () => {
    addTodo('Ship the beta', lt.id);
    addTodo('Draft Q4 positioning', tx.id);
    addTodo('Book the offsite', tx.id, 'ares');
    await renderLoadedPage();
    const merge = await within(manage()).findByRole('form', { name: 'Merge' });

    fireEvent.change(within(merge).getByLabelText('Merge with'), { target: { value: tx.id } });
    fireEvent.click(within(merge).getByRole('radio', { name: /Keep Longtail/ }));
    fireEvent.submit(merge);
    const confirm = await screen.findByRole('dialog', { name: /Merge Tactics into Longtail/ });
    expect(confirm.textContent).toMatch(/2 Items move/);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Merge' }));

    await waitFor(() => expect(store.query({ projectId: lt.id })).toHaveLength(3));
    expect(store.projects().map((p) => p.code)).toEqual(['LT', 'TL']);
    await waitFor(() => expect(within(openTodos()).getAllByRole('listitem')).toHaveLength(3));

    const toast = (await screen.findByText(/Merged TX into LT: 2 Items moved/)).closest('li') as HTMLElement;
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(store.query({ projectId: tx.id })).toHaveLength(2));
    expect(store.projects().map((p) => p.code)).toEqual(['LT', 'TL', 'TX']);
  });

  it('opens the kept Project’s page when its own Project is merged away', async () => {
    addTodo('Ship the beta', lt.id);
    const { onOpenPage } = await renderLoadedPage();
    const merge = await within(manage()).findByRole('form', { name: 'Merge' });

    fireEvent.change(within(merge).getByLabelText('Merge with'), { target: { value: tx.id } });
    fireEvent.click(within(merge).getByRole('radio', { name: /Keep Tactics/ }));
    fireEvent.submit(merge);
    const confirm = await screen.findByRole('dialog', { name: /Merge Longtail into Tactics/ });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Merge' }));

    await waitFor(() => expect(onOpenPage).toHaveBeenCalledWith(tx.id));
    expect(store.query({ projectId: tx.id })).toHaveLength(1);
  });

  it('lists the Rules filing into the Project, each opening in the editor, and counts Rule filings', async () => {
    const rule = (projectId: string, key: string) =>
      store.changeRule({
        type: 'create',
        rule: {
          target: { kind: 'project', projectId },
          when: {
            join: 'and',
            terms: [{ field: 'linear.team', op: 'is', value: `team-${key}`, label: key }],
          },
        },
      });
    rule(tx.id, 'OPS');
    rule(lt.id, 'ENG');
    store.saveFromSource({
      source: 'linear',
      account: 'linear:org-acme',
      items: [{ externalId: 'a', kind: 'linear-issue', title: 'Fix the login loop', detail: null }],
    });
    const [issue] = store.query({ kinds: ['linear-issue'] });
    store.record(
      { type: 'update', itemId: issue?.id ?? '', changes: { filing: { projectId: lt.id, filedBy: 'rule' } } },
      { by: { kind: 'rule', ruleId: 'r' } },
    );
    await renderLoadedPage();

    const mapping = await screen.findByRole('region', { name: 'Mapping Rules' });
    const listed = await within(mapping).findByRole('list', { name: 'Rules filing into this Project' });
    expect(
      within(listed)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual(['02team is ENG']);
    await waitFor(() => expect(filingRow('By Rule').textContent).toMatch(/01$/));

    fireEvent.click(within(listed).getByRole('button', { name: /team is ENG/ }));
    const editor = await screen.findByRole('dialog', { name: 'Edit Rule' });
    expect((within(editor).getByRole('combobox', { name: 'Files into' }) as HTMLSelectElement).value).toBe(
      lt.id,
    );
  });
});
