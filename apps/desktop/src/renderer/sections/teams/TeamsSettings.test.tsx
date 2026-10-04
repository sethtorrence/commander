// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestItemStore } from '../../item-store/test-item-store';
import { TeamsSettings } from './TeamsSettings';
import { teamsChatsIn } from './teams-chats';
import { chat, TEAMS } from './test-chats';

// Settings → Teams: the Chats the User muted or excluded, with Unmute and Include again.

let store: ItemStore;
let close: () => void;
let client: ReturnType<typeof openTestItemStore>['client'];
let synced: string[];

beforeEach(() => {
  ({ store, close, client } = openTestItemStore());
  synced = [];
  store.saveFromSource({
    source: 'teams',
    account: TEAMS,
    items: [
      chat({ id: '19:social@thread.v2', title: 'Social' }),
      chat({ id: '19:noisy@thread.v2', title: 'Noisy' }),
    ],
  });
});

afterEach(() => {
  cleanup();
  close();
});

const change = (chatId: string, kind: 'mute' | 'exclude') =>
  store.chatSettings.change({ account: TEAMS, chatId, change: kind }, { by: { kind: 'user' } });

function renderSettings() {
  return render(
    <TeamsSettings
      no="13"
      chats={teamsChatsIn(client)}
      syncNow={async (account) => {
        synced.push(account);
      }}
    />,
  );
}

describe('Settings → Teams', () => {
  it('says when no Chat is muted or excluded', async () => {
    renderSettings();
    await waitFor(() => expect(screen.getByText(/No muted or excluded chats/)).toBeTruthy());
  });

  it('lists excluded Chats with Include again, which brings each back on the next sync', async () => {
    change('19:social@thread.v2', 'exclude');
    renderSettings();
    const excluded = await screen.findByRole('region', { name: 'Excluded chats' });
    expect(within(excluded).getByText('Social')).toBeTruthy();

    fireEvent.click(within(excluded).getByRole('button', { name: 'Include Social again' }));

    await waitFor(() => expect(store.chatSettings.excluded(TEAMS)).toEqual([]));
    expect(synced).toEqual([TEAMS]);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Excluded chats' })).toBeNull());
  });

  it('lists muted Chats with Unmute', async () => {
    change('19:noisy@thread.v2', 'mute');
    renderSettings();
    const muted = await screen.findByRole('region', { name: 'Muted chats' });

    fireEvent.click(within(muted).getByRole('button', { name: 'Unmute Noisy' }));

    await waitFor(() => expect(store.chatSettings.list()).toEqual([]));
  });
});
