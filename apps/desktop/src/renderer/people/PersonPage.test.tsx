// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onReveal } from '../frame/reveal';
import type { ItemStoreClient } from '../item-store/client';
import { openTestItemStore } from '../item-store/test-item-store';
import { peopleViewIn } from '../sections/github/people';
import { GITHUB, NOW, pull } from '../sections/github/test-work';
import { ShortcutProvider, ShortcutScope, useActiveScopes } from '../shortcuts/react';
import { PeopleProvider } from './context';
import { PEOPLE_SETTINGS } from './PeopleSettings';
import { PersonName } from './PersonName';
import { PERSON_PAGE_SCOPE, PersonPage } from './PersonPage';
import { peopleIn } from './people';

// A Person's page (#122): their card over a longer range, their handles, and the way to Settings →
// People; and a Person's name in a detail pane opening it.

const DAY = 24 * 3_600_000;

let store: ItemStore;
let client: ItemStoreClient;
let close: () => void;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  ({ store, client, close } = openTestItemStore());
  store.saveFromSource({
    source: 'github',
    account: GITHUB,
    items: [
      {
        ...pull({ number: 41, title: 'Retry webhooks', state: 'merged', mergedAt: NOW - 20 * DAY }),
        identities: [{ handle: 'github:priya', name: 'Priya Raman', email: 'priya@acme.test' }],
      },
      pull({ number: 42, title: 'Back off retries', state: 'merged', mergedAt: NOW - 50 * DAY }),
    ],
  });
});

afterEach(() => {
  cleanup();
  close();
  vi.useRealTimers();
});

function Active() {
  useActiveScopes([PERSON_PAGE_SCOPE]);
  return null;
}

function renderPage(
  props: { onOpenSettings?: () => void; onBack?: () => void; onOpenSection?: () => void } = {},
) {
  const priya = store.people.list().find((each) => each.name === 'Priya Raman');
  render(
    <ShortcutProvider>
      <PeopleProvider client={peopleIn(client)}>
        <Active />
        <ShortcutScope scope={PERSON_PAGE_SCOPE} group="Person page">
          <PersonPage
            personId={priya?.id ?? ''}
            active
            client={peopleViewIn(client)}
            back={{ label: 'GitHub', onClick: props.onBack ?? (() => {}) }}
            onOpenSection={props.onOpenSection ?? (() => {})}
            onOpenSettings={props.onOpenSettings ?? (() => {})}
          />
        </ShortcutScope>
      </PeopleProvider>
    </ShortcutProvider>,
  );
  return priya;
}

describe('a Person’s page', () => {
  it('shows their card over the last 30 days, or 90, with their handles', async () => {
    renderPage();
    const page = await screen.findByTestId('person-page');
    await waitFor(() =>
      expect(within(page).getByRole('heading', { name: 'Priya Raman', level: 1 })).toBeTruthy(),
    );
    await waitFor(() => expect(within(page).getByLabelText('Merged: 1')).toBeTruthy());
    expect(within(page).getByTestId('person-merged').textContent).toContain('Retry webhooks');
    expect(screen.getByTestId('person-handles').textContent).toContain('@priya');
    expect(screen.getByTestId('person-handles').textContent).toContain('priya@acme.test');

    fireEvent.click(screen.getByRole('button', { name: 'Last 90 days' }));
    await waitFor(() => expect(within(page).getByLabelText('Merged: 2')).toBeTruthy());
  });

  it('opens Settings → People at them, a pull request in the GitHub Section, and closes on Esc', async () => {
    const onOpenSettings = vi.fn();
    const onBack = vi.fn();
    const onOpenSection = vi.fn();
    const revealed: string[] = [];
    const stopSettings = onReveal(PEOPLE_SETTINGS, (id) => revealed.push(`settings:${id}`));
    const stopGitHub = onReveal('github', (id) => revealed.push(`github:${id}`));
    const priya = renderPage({ onOpenSettings, onBack, onOpenSection });
    fireEvent.click(await screen.findByTestId('person-manage'));
    expect(onOpenSettings).toHaveBeenCalled();
    expect(revealed).toContain(`settings:${priya?.id}`);

    fireEvent.click(await screen.findByTitle('Open acme/api#41'));
    expect(onOpenSection).toHaveBeenCalledWith('github');
    expect(revealed).toContain(`github:${store.query({ titleContains: 'Retry webhooks' })[0]?.id}`);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onBack).toHaveBeenCalled();
    stopSettings();
    stopGitHub();
  });
});

describe('a Person’s name in a detail pane', () => {
  it('opens their page where People have pages, and stays plain text where they don’t', async () => {
    const openPerson = vi.fn();
    const priya = store.people.list().find((each) => each.name === 'Priya Raman');
    const { unmount } = render(
      <PeopleProvider client={peopleIn(client)} onOpenPerson={openPerson}>
        <PersonName handle="github:priya" fallback="priya" />
      </PeopleProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Priya Raman' }));
    expect(openPerson).toHaveBeenCalledWith(priya?.id);
    unmount();

    render(
      <PeopleProvider client={peopleIn(client)}>
        <PersonName handle="github:priya" fallback="priya" />
      </PeopleProvider>,
    );
    await screen.findByText('Priya Raman');
    expect(screen.queryByRole('button', { name: 'Priya Raman' })).toBeNull();
  });
});
