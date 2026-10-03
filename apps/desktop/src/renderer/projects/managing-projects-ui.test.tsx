// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { Filing, Project } from '@commander/domain';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openTestItemStore } from '../item-store/test-item-store';
import { ShortcutProvider } from '../shortcuts/react';
import { BadgePicker } from './BadgePicker';
import { ItemBadge, SectionProjectFilter } from './badges';
import { type ProjectsApi, ProjectsProvider, useProjects } from './context';
import { moved, ProjectsSettings } from './ProjectsSettings';
import { projectsIn } from './projects';

// Managing Projects in the window (Settings → Projects, the filter bar, the Badge picker, `p` then o)
// against a real Item store on a temporary database.
let store: ItemStore;
let close: () => void;
let projects: ReturnType<typeof projectsIn>;
let lt: Project;
let tl: Project;
let tx: Project;
let api: ProjectsApi;

beforeEach(() => {
  localStorage.clear();
  const opened = openTestItemStore();
  ({ store, close } = opened);
  projects = projectsIn(opened.client);
  lt = create('Longtail', 'LT', 'blue');
  tl = create('Titanlink', 'TL', 'teal');
  tx = create('Tactics', 'TX', 'violet');
});

afterEach(() => {
  cleanup();
  close();
});

function create(name: string, code: string, accent: string) {
  return store.changeProject({ type: 'create', project: { name, code, accent } }).project as Project;
}

function Probe() {
  api = useProjects();
  return null;
}

function renderAll(children: React.ReactNode, onOpenPage = vi.fn()) {
  render(
    <ShortcutProvider>
      <ProjectsProvider client={projects} storage={localStorage} onOpenPage={onOpenPage}>
        <Probe />
        {children}
      </ProjectsProvider>
    </ShortcutProvider>,
  );
  return { onOpenPage };
}

const press = (key: string) => fireEvent.keyDown(document.activeElement ?? document.body, { key });
const bar = () => screen.getByRole('group', { name: 'Project filter' });
const barProjects = () =>
  within(bar())
    .getAllByRole('img')
    .map((badge) => badge.textContent);
const order = () =>
  within(screen.getByRole('list', { name: 'Projects' }))
    .getAllByRole('listitem')
    .map((row) => within(row).getByRole('img').textContent);

describe('moving a Project in a list', () => {
  it.each([
    [['a', 'b', 'c'], 'a', 2, ['b', 'c', 'a']],
    [['a', 'b', 'c'], 'c', 0, ['c', 'a', 'b']],
    [['a', 'b', 'c'], 'b', 1, ['a', 'b', 'c']],
    [['a', 'b', 'c'], 'a', 9, ['b', 'c', 'a']],
  ])('%j moving %s to %i gives %j', (ids, id, to, expected) => {
    expect(moved(ids, id, to)).toEqual(expected);
  });
});

describe('putting Projects in order in Settings', () => {
  it('moves a Project with its arrows, and the filter bar and the p keys follow', async () => {
    renderAll(
      <>
        <ProjectsSettings no="02" />
        <SectionProjectFilter items={[]} />
      </>,
    );
    await waitFor(() => expect(order()).toEqual(['LT', 'TL', 'TX']));

    fireEvent.click(screen.getByRole('button', { name: 'Move Tactics up' }));
    await waitFor(() => expect(order()).toEqual(['LT', 'TX', 'TL']));
    expect(store.projects().map((p) => p.code)).toEqual(['LT', 'TX', 'TL']);
    expect(barProjects()).toEqual(['LT', 'TX', 'TL', '—']);

    act(() => {
      press('p');
      press('2');
    });
    expect(api.filter).toBe(tx.id);
  });

  it('moves a Project by dragging its row onto another', async () => {
    renderAll(<ProjectsSettings no="02" />);
    await waitFor(() => expect(order()).toEqual(['LT', 'TL', 'TX']));
    const rows = within(screen.getByRole('list', { name: 'Projects' })).getAllByRole('listitem');
    const dataTransfer = { setData: vi.fn(), getData: () => lt.id, effectAllowed: '' };

    fireEvent.dragStart(rows[0] as HTMLElement, { dataTransfer });
    fireEvent.dragOver(rows[2] as HTMLElement, { dataTransfer });
    fireEvent.drop(rows[2] as HTMLElement, { dataTransfer });

    await waitFor(() => expect(order()).toEqual(['TL', 'TX', 'LT']));
  });

  it('opens a Project’s page from its row', async () => {
    const { onOpenPage } = renderAll(<ProjectsSettings no="02" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open the Titanlink page' }));
    expect(onOpenPage).toHaveBeenCalledWith(tl.id);
  });
});

describe('an archived Project', () => {
  const filing: Filing = { projectId: '', filedBy: 'user' };

  it('leaves the filter bar and the Badge picker, while its Items keep their Badges', async () => {
    store.changeProject({ type: 'archive', projectId: tl.id });
    renderAll(
      <>
        <SectionProjectFilter items={[]} />
        <ItemBadge filing={{ ...filing, projectId: tl.id }} data-testid="old-item" />
        <BadgePicker
          target={{ id: 't1', title: 'Old task', filing: { ...filing, projectId: tl.id } }}
          anchor={null}
          onPick={vi.fn()}
          onClose={vi.fn()}
        />
      </>,
    );

    await waitFor(() => expect(barProjects()).toEqual(['LT', 'TX', '—']));
    expect(screen.getByTestId('old-item').textContent).toBe('TL');
    const picker = screen.getByRole('dialog', { name: 'Badge picker' });
    expect(
      within(picker)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      expect.stringContaining('Longtail'),
      expect.stringContaining('Tactics'),
      expect.stringContaining('Unfiled'),
    ]);
  });

  it('is listed under Archived in Settings, and Unarchive puts it back at the end of the order', async () => {
    store.changeProject({ type: 'archive', projectId: lt.id });
    renderAll(
      <>
        <ProjectsSettings no="02" />
        <SectionProjectFilter items={[]} />
      </>,
    );
    const archivedList = await screen.findByRole('list', { name: 'Archived' });
    expect(
      within(archivedList)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual([expect.stringContaining('Longtail')]);

    fireEvent.click(within(archivedList).getByRole('button', { name: 'Unarchive' }));

    await waitFor(() => expect(order()).toEqual(['TL', 'TX', 'LT']));
    expect(screen.queryByRole('list', { name: 'Archived' })).toBeNull();
    expect(barProjects()).toEqual(['TL', 'TX', 'LT', '—']);
  });

  it('stops being the filter, which falls back to Everything', async () => {
    renderAll(null);
    await waitFor(() => expect(api.projects).toHaveLength(3));
    act(() => api.setFilter(tx.id));

    await act(() => api.change({ type: 'archive', projectId: tx.id }));

    expect(api.filter).toBe('everything');
  });
});

describe('opening a Project page', () => {
  it('opens the selected Project’s page with p then o, and only when a Project is selected', async () => {
    const { onOpenPage } = renderAll(null);
    await waitFor(() => expect(api.projects).toHaveLength(3));

    act(() => {
      press('p');
      press('o');
    });
    expect(onOpenPage).not.toHaveBeenCalled();

    act(() => {
      press('p');
      press('3');
    });
    act(() => {
      press('p');
      press('o');
    });
    expect(onOpenPage).toHaveBeenCalledWith(tx.id);
  });

  it('opens from the filter bar’s open control', async () => {
    const { onOpenPage } = renderAll(<SectionProjectFilter items={[]} />);
    fireEvent.click(await within(bar()).findByRole('button', { name: 'Open the Longtail page' }));
    expect(onOpenPage).toHaveBeenCalledWith(lt.id);
  });
});
