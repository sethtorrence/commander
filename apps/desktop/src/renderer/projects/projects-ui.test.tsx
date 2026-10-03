// @vitest-environment jsdom
import type { ActivityEntry, Project } from '@commander/domain';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShortcutProvider } from '../shortcuts/react';
import { BadgePicker, matchChoices } from './BadgePicker';
import { SectionProjectFilter } from './badges';
import { ProjectsProvider, useProjects } from './context';
import { FILTER_STORAGE_KEY } from './filter';
import { firstUnusedAccent, ProjectsSettings } from './ProjectsSettings';
import type { ProjectsClient } from './projects';

const project = (id: string, code: string, name: string, order: number): Project => ({
  id,
  code,
  name,
  accent: 'blue',
  order,
  archived: false,
  createdAt: 0,
});
const lt = project('p-lt', 'LT', 'Longtail', 0);
const tl = project('p-tl', 'TL', 'Titanlink', 1);
const tx = project('p-tx', 'TX', 'Tactics', 2);

function fakeClient(projects: Project[]): ProjectsClient {
  return {
    list: async () => projects,
    create: vi.fn(),
    file: vi.fn(async () => ({}) as ActivityEntry),
  };
}

function Providers({ children, projects = [lt, tl, tx] }: { children: ReactNode; projects?: Project[] }) {
  return (
    <ShortcutProvider>
      <ProjectsProvider client={fakeClient(projects)} storage={localStorage}>
        {children}
      </ProjectsProvider>
    </ShortcutProvider>
  );
}

const press = (key: string) => fireEvent.keyDown(document.activeElement ?? document.body, { key });

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('matching Badge picker choices', () => {
  const codes = (query: string) => matchChoices([lt, tl, tx], query).map((c) => c.project?.code ?? '—');

  it('offers every Project in order, then Unfiled', () => {
    expect(codes('')).toEqual(['LT', 'TL', 'TX', '—']);
  });

  it('puts an exact code first, then codes and names that start with what was typed', () => {
    expect(codes('tx')).toEqual(['TX']);
    expect(codes('t')).toEqual(['TL', 'TX', 'LT']);
    expect(codes('tit')).toEqual(['TL']);
    expect(codes('unf')).toEqual(['—']);
    expect(codes('link')).toEqual(['TL']);
    expect(codes('zz')).toEqual([]);
  });
});

describe('the Badge picker', () => {
  function renderPicker() {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      <Providers>
        <BadgePicker
          target={{ id: 't1', title: 'Ship the beta', filing: null }}
          anchor={null}
          onPick={onPick}
          onClose={onClose}
        />
      </Providers>,
    );
    return { onPick, onClose, input: screen.getByRole('combobox', { name: /code or name/ }) };
  }

  it('files into the Project typed, with Enter', async () => {
    const { onPick, input } = renderPicker();
    await screen.findByRole('option', { name: /Titanlink/ });

    fireEvent.change(input, { target: { value: 'tl' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onPick).toHaveBeenCalledWith('p-tl');
  });

  it('files with a number key, or unfiles by choosing Unfiled', async () => {
    const { onPick, input } = renderPicker();
    await screen.findByRole('option', { name: /Tactics/ });

    fireEvent.keyDown(input, { key: '3' });
    fireEvent.click(screen.getByRole('option', { name: /Unfiled/ }));

    expect(onPick.mock.calls).toEqual([['p-tx'], [null]]);
  });

  it('moves with the arrow keys and closes with Escape', async () => {
    const { onPick, onClose, input } = renderPicker();
    await screen.findByRole('option', { name: /Longtail/ });

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onPick).toHaveBeenCalledWith('p-tl');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('marks where the Item is filed now', async () => {
    renderPicker();

    expect(await screen.findByRole('option', { name: /Unfiled/ })).toHaveProperty(
      'textContent',
      '—UnfiledCurrent4',
    );
  });
});

describe('the Project filter', () => {
  let api: ReturnType<typeof useProjects>;
  function Probe() {
    api = useProjects();
    return null;
  }

  it('is set with p then a number, 0 or u, and remembered', async () => {
    render(
      <Providers>
        <Probe />
      </Providers>,
    );
    await waitFor(() => expect(api.projects).toHaveLength(3));

    act(() => {
      press('p');
      press('2');
    });
    expect(api.filter).toBe('p-tl');
    expect(localStorage.getItem(FILTER_STORAGE_KEY)).toBe('p-tl');

    act(() => {
      press('p');
      press('u');
    });
    expect(api.filter).toBe('unfiled');

    act(() => {
      press('p');
      press('0');
    });
    expect(api.filter).toBe('everything');
  });

  it('starts from the remembered filter, unless its Project is gone', async () => {
    localStorage.setItem(FILTER_STORAGE_KEY, 'p-tx');
    const { unmount } = render(
      <Providers>
        <Probe />
      </Providers>,
    );
    await waitFor(() => expect(api.projects).toHaveLength(3));
    expect(api.filter).toBe('p-tx');
    unmount();

    render(
      <Providers projects={[lt]}>
        <Probe />
      </Providers>,
    );
    await waitFor(() => expect(api.projects).toHaveLength(1));
    expect(api.filter).toBe('everything');
  });

  it('shows the Section’s counts and selects on click', async () => {
    render(
      <Providers>
        <Probe />
        <SectionProjectFilter
          items={[
            { filing: { projectId: 'p-lt', filedBy: 'user' } },
            { filing: { projectId: 'p-lt', filedBy: 'user' } },
            { filing: null },
          ]}
        />
      </Providers>,
    );
    const bar = screen.getByRole('group', { name: 'Project filter' });
    await within(bar).findByRole('button', { name: /Longtail/ });

    expect(within(bar).getByRole('button', { name: /Everything/ }).textContent).toMatch(/03$/);
    expect(within(bar).getByRole('button', { name: /Longtail/ }).textContent).toMatch(/02$/);
    expect(within(bar).getByRole('button', { name: /Unfiled/ }).textContent).toMatch(/01$/);

    fireEvent.click(within(bar).getByRole('button', { name: /Tactics/ }));
    expect(api.filter).toBe('p-tx');
  });
});

describe('Settings → Projects', () => {
  it('preselects the first accent no Project uses', () => {
    expect(firstUnusedAccent([])).toBe('blue');
    expect(firstUnusedAccent([{ accent: 'blue' }, { accent: 'violet' }])).toBe('teal');
  });

  it('creates a Project with the name, code and accent given, and shows why one is refused', async () => {
    const client = fakeClient([lt]);
    vi.mocked(client.create)
      .mockResolvedValueOnce(tl)
      .mockRejectedValueOnce(new Error('TL is already the Badge code for Titanlink'));
    render(
      <ShortcutProvider>
        <ProjectsProvider client={client} storage={localStorage}>
          <ProjectsSettings no="02" />
        </ProjectsProvider>
      </ShortcutProvider>,
    );
    const form = screen.getByRole('form', { name: 'New Project' });
    await screen.findByRole('listitem');
    expect(within(form).getByRole('radio', { name: 'teal' })).toHaveProperty('checked', true);

    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Titanlink' } });
    fireEvent.change(within(form).getByLabelText('Badge code'), { target: { value: 'tl' } });
    fireEvent.click(within(form).getByRole('radio', { name: 'green' }));
    fireEvent.submit(form);

    await waitFor(() =>
      expect(client.create).toHaveBeenCalledWith({ name: 'Titanlink', code: 'TL', accent: 'green' }),
    );
    await waitFor(() => expect(within(form).getByLabelText('Name')).toHaveProperty('value', ''));

    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Tealight' } });
    fireEvent.change(within(form).getByLabelText('Badge code'), { target: { value: 'TL' } });
    fireEvent.submit(form);

    expect((await within(form).findByRole('alert')).textContent).toBe(
      'TL is already the Badge code for Titanlink',
    );
  });
});
