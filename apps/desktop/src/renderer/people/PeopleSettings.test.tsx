// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import { Toaster } from '@commander/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requestReveal } from '../frame/reveal';
import { openTestItemStore } from '../item-store/test-item-store';
import { PeopleProvider } from './context';
import { PEOPLE_SETTINGS, PeopleSettings } from './PeopleSettings';
import { peopleIn } from './people';

// Settings → People against a real Item store on a temporary database: everyone Commander knows,
// searchable, with their handles by Source; Merge, Split and Rename, each undoable from its toast.

let store: ItemStore;
let close: () => void;
let client: ReturnType<typeof openTestItemStore>['client'];

beforeEach(() => {
  ({ store, close, client } = openTestItemStore());
  Element.prototype.scrollIntoView = () => {};
  store.saveFromSource({
    source: 'linear',
    account: 'linear:org-acme',
    items: [
      {
        externalId: 'issue-1',
        kind: 'linear-issue',
        title: 'Fix the login loop',
        people: ['linear:u-priya', 'priya@acme.io'],
        identities: [{ handle: 'linear:u-priya', email: 'priya@acme.io', name: 'Priya Patel' }],
      },
    ],
  });
  store.saveFromSource({
    source: 'github',
    account: 'github:42',
    items: [
      { externalId: 'pr-1', kind: 'pull-request', title: 'Retry webhooks', people: ['github:pp-dev'] },
      {
        externalId: 'pr-2',
        kind: 'pull-request',
        title: 'Rotate keys',
        people: ['github:lee-c'],
        identities: [{ handle: 'github:lee-c', email: 'lee@acme.io', name: 'Lee Chen' }],
      },
    ],
  });
});

afterEach(() => {
  cleanup();
  close();
});

function renderPeople() {
  return render(
    <PeopleProvider client={peopleIn(client)}>
      <PeopleSettings no="16" />
      <Toaster />
    </PeopleProvider>,
  );
}

const rows = () => screen.queryAllByTestId('person-row');
const names = () => rows().map((row) => row.getAttribute('aria-label'));
const rowOf = (name: string) => rows().find((row) => row.getAttribute('aria-label') === name) as HTMLElement;
// Undo in the toast that says `said` (toasts from earlier tests may linger).
const undoToast = async (said: string) => {
  const toast = (await screen.findByText(said)).closest('[data-sonner-toast]') as HTMLElement;
  fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
};

describe('Settings → People', () => {
  it('lists everyone Commander knows with their handles by Source, and finds them by name or handle', async () => {
    renderPeople();
    await waitFor(() => expect(names()).toEqual(['Lee Chen', 'pp-dev', 'Priya Patel']));
    const priya = rowOf('Priya Patel');
    expect(within(priya).getByText('Linear').nextSibling?.textContent).toBe('Priya Patel');
    expect(within(priya).getByText('priya@acme.io')).toBeTruthy();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search People' }), { target: { value: 'pri' } });
    expect(names()).toEqual(['Priya Patel']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search People' }), { target: { value: 'lee@' } });
    expect(names()).toEqual(['Lee Chen']);
  });

  it('merges two People, keeping the name chosen, and Undo brings both back', async () => {
    renderPeople();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(within(rowOf('pp-dev')).getByRole('checkbox', { name: 'Choose pp-dev' }));
    fireEvent.click(within(rowOf('Priya Patel')).getByRole('checkbox', { name: 'Choose Priya Patel' }));
    const merging = screen.getByRole('group', { name: 'Merge People' });
    fireEvent.click(within(merging).getByRole('radio', { name: 'Priya Patel' }));
    fireEvent.click(within(merging).getByRole('button', { name: 'Merge' }));

    await waitFor(() => expect(names()).toEqual(['Lee Chen', 'Priya Patel']));
    expect(within(rowOf('Priya Patel')).getByText('@pp-dev')).toBeTruthy();
    expect(store.people.list()).toHaveLength(2);

    await undoToast('Merged pp-dev into Priya Patel');
    await waitFor(() => expect(names()).toEqual(['Lee Chen', 'pp-dev', 'Priya Patel']));
  });

  it('splits a handle out to a Person of their own, and Undo puts it back', async () => {
    store.saveFromSource({
      source: 'github',
      account: 'github:42',
      items: [
        {
          externalId: 'pr-3',
          kind: 'pull-request',
          title: 'Docs',
          people: ['github:priya-p'],
          identities: [{ handle: 'github:priya-p', email: 'priya@acme.io' }],
        },
      ],
    });
    renderPeople();
    await waitFor(() => expect(names()).toEqual(['Lee Chen', 'pp-dev', 'Priya Patel']));
    const priya = rowOf('Priya Patel');
    fireEvent.click(within(priya).getByRole('button', { name: 'Split Priya Patel' }));
    fireEvent.click(within(priya).getByRole('checkbox', { name: '@priya-p' }));
    fireEvent.click(within(priya).getByRole('button', { name: 'Split off' }));

    await waitFor(() => expect(names()).toEqual(['Lee Chen', 'pp-dev', 'Priya Patel', 'priya-p']));
    expect(within(rowOf('Priya Patel')).queryByText('@priya-p')).toBeNull();

    await undoToast('Split a handle from Priya Patel');
    await waitFor(() => expect(names()).toEqual(['Lee Chen', 'pp-dev', 'Priya Patel']));
  });

  it('renames a Person, whose name then wins over every Source’s, and can go back to the Sources’ name', async () => {
    renderPeople();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(within(rowOf('pp-dev')).getByRole('button', { name: 'Rename pp-dev' }));
    const input = screen.getByRole('textbox', { name: 'Name for pp-dev' });
    fireEvent.change(input, { target: { value: 'Priya (dev)' } });
    fireEvent.submit(input);

    await waitFor(() => expect(names()).toContain('Priya (dev)'));
    expect(within(rowOf('Priya (dev)')).getByText('Your name')).toBeTruthy();
    fireEvent.click(within(rowOf('Priya (dev)')).getByRole('button', { name: 'Rename Priya (dev)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use the Sources’ name' }));
    await waitFor(() => expect(names()).toContain('pp-dev'));
  });

  it('opens at a Person asked for (from Ctrl+K), clearing the search', async () => {
    renderPeople();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search People' }), { target: { value: 'lee' } });
    const priya = store.people.list().find((person) => person.name === 'Priya Patel');
    act(() => requestReveal(PEOPLE_SETTINGS, priya?.id ?? ''));
    await waitFor(() => expect(rowOf('Priya Patel')?.getAttribute('aria-current')).toBe('true'));
    expect(rows()).toHaveLength(3);
  });
});
