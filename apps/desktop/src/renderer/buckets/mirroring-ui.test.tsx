// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import { BUCKET_MIRROR_FIELD, MIRROR_BUCKETS } from '@commander/domain';
import type { AccountsResponse, GoogleAccountSummary, OutlookAccountSummary } from '@commander/domain/ipc';
import { Toaster } from '@commander/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemStoreClient } from '../item-store/client';
import { openTestItemStore } from '../item-store/test-item-store';
import { BucketMirroringSetting } from './BucketMirroring';
import { mirroringIn } from './mirroring';

// Mirror Buckets in Settings → Accounts (#142), against a real Item store on a temporary database:
// off by default with a line saying Commander's Buckets may differ from Gmail or Outlook; switching on
// explains what will happen first (and, for Outlook, asks for MailboxSettings.ReadWrite through Grant
// access before anything else); switching off offers to remove Commander's labels or keep them.

let store: ItemStore;
let client: ItemStoreClient;
let close: () => void;
let grant: ReturnType<typeof vi.fn<(accountId: string) => Promise<AccountsResponse>>>;

const gmail: GoogleAccountSummary = {
  id: 'google:alex',
  source: 'google',
  name: 'Google · alex@gmail.test',
  email: 'alex@gmail.test',
  method: 'oauth',
  status: 'connected',
  user: { id: 'alex', name: 'Alex Kim' },
  sync: null,
  sources: [
    { source: 'gmail', granted: true, enabled: true },
    { source: 'google-calendar', granted: true, enabled: true },
  ],
};
const outlook: OutlookAccountSummary = {
  id: 'outlook:tenant:sam',
  source: 'outlook',
  name: 'Outlook · sam@contoso.test',
  userPrincipalName: 'sam@contoso.test',
  method: 'oauth',
  status: 'connected',
  user: { id: 'sam', name: 'Sam Rivera' },
  sync: null,
  sources: [
    { source: 'outlook', granted: true, enabled: true },
    { source: 'outlook-calendar', granted: true, enabled: true },
  ],
};

beforeEach(() => {
  ({ store, client, close } = openTestItemStore());
  grant = vi.fn(
    async () => ({ ok: true, state: { accounts: [], sources: [], deviceCode: null } }) as AccountsResponse,
  );
});

afterEach(() => {
  cleanup();
  close();
});

function renderFor(account: GoogleAccountSummary | OutlookAccountSummary) {
  const mirroring = mirroringIn(client, grant);
  return render(
    <>
      <BucketMirroringSetting account={account} client={mirroring} />
      <Toaster />
    </>,
  );
}

const theSwitch = (name: RegExp) => screen.findByRole('switch', { name });

describe('Mirror Buckets in Settings → Accounts', () => {
  it('is off by default, saying Commander’s Buckets may differ from how mail is organised in Gmail', async () => {
    renderFor(gmail);
    expect((await theSwitch(/Mirror Buckets to Gmail/)).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('bucket-mirroring').textContent).toMatch(
      /Commander’s Buckets may differ from how you organise mail in Gmail/,
    );
    expect(store.bucketMirror.list()).toEqual([]);
  });

  it('explains what will happen before switching on, and only then switches on', async () => {
    renderFor(gmail);
    fireEvent.click(await theSwitch(/Mirror Buckets to Gmail/));
    const dialog = await screen.findByRole('dialog', { name: 'Mirror Buckets to Gmail' });
    expect(dialog.textContent).toMatch(/Commander\/<Bucket> label/);
    expect(dialog.textContent).toMatch(/never changes your own labels/);
    expect(store.bucketMirror.list()).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Mirror Buckets' }));
    await waitFor(() => expect(store.bucketMirror.mirrors(gmail.id)).toBe(true));
    expect(store.autonomy.settings().actions[MIRROR_BUCKETS]).toBe('auto');
    await waitFor(async () =>
      expect((await theSwitch(/Mirror Buckets to Gmail/)).getAttribute('aria-checked')).toBe('true'),
    );
  });

  it('Cancel leaves it off', async () => {
    renderFor(gmail);
    fireEvent.click(await theSwitch(/Mirror Buckets to Gmail/));
    const dialog = await screen.findByRole('dialog', { name: 'Mirror Buckets to Gmail' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(store.bucketMirror.list()).toEqual([]);
  });

  it('for Outlook, asks Microsoft for MailboxSettings.ReadWrite first (Grant access), then switches on', async () => {
    renderFor(outlook);
    fireEvent.click(await theSwitch(/Mirror Buckets to Outlook/));
    const dialog = await screen.findByRole('dialog', { name: 'Mirror Buckets to Outlook' });
    expect(dialog.textContent).toMatch(/MailboxSettings\.ReadWrite/);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant access and mirror' }));
    await waitFor(() => expect(store.bucketMirror.mirrors(outlook.id)).toBe(true));
    expect(grant).toHaveBeenCalledWith(outlook.id);
  });

  it('for Outlook, stays off when Microsoft didn’t grant it, saying why', async () => {
    grant.mockResolvedValueOnce({
      ok: false,
      error: 'Microsoft didn’t grant MailboxSettings.ReadWrite.',
      state: { accounts: [], sources: [], deviceCode: null },
    });
    renderFor(outlook);
    fireEvent.click(await theSwitch(/Mirror Buckets to Outlook/));
    const dialog = await screen.findByRole('dialog', { name: 'Mirror Buckets to Outlook' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant access and mirror' }));
    expect(await screen.findByText(/didn’t grant MailboxSettings\.ReadWrite/)).toBeTruthy();
    expect(store.bucketMirror.list()).toEqual([]);
  });

  it('an Outlook Account already granted goes straight on after the explanation', async () => {
    renderFor({ ...outlook, mailboxSettings: { granted: true } });
    fireEvent.click(await theSwitch(/Mirror Buckets to Outlook/));
    const dialog = await screen.findByRole('dialog', { name: 'Mirror Buckets to Outlook' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mirror Buckets' }));
    await waitFor(() => expect(store.bucketMirror.mirrors(outlook.id)).toBe(true));
    expect(grant).not.toHaveBeenCalled();
  });

  it('switching off offers to remove Commander’s labels or keep them', async () => {
    store.bucketMirror.set({ account: gmail.id, source: 'gmail', enabled: true });
    renderFor(gmail);
    await waitFor(async () =>
      expect((await theSwitch(/Mirror Buckets to Gmail/)).getAttribute('aria-checked')).toBe('true'),
    );
    fireEvent.click(await theSwitch(/Mirror Buckets to Gmail/));
    const dialog = await screen.findByRole('dialog', { name: 'Stop mirroring Buckets' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Commander labels' }));
    await waitFor(() => expect(store.bucketMirror.list()[0]).toMatchObject({ enabled: false }));
    expect(store.outgoing.list().filter((change) => change.field === BUCKET_MIRROR_FIELD)).toEqual([]);
  });

  it('keeping the labels just stops writing', async () => {
    store.bucketMirror.set({ account: gmail.id, source: 'gmail', enabled: true });
    renderFor(gmail);
    await waitFor(async () =>
      expect((await theSwitch(/Mirror Buckets to Gmail/)).getAttribute('aria-checked')).toBe('true'),
    );
    fireEvent.click(await theSwitch(/Mirror Buckets to Gmail/));
    const dialog = await screen.findByRole('dialog', { name: 'Stop mirroring Buckets' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep them' }));
    await waitFor(() =>
      expect(store.bucketMirror.list()[0]).toMatchObject({ enabled: false, removing: false }),
    );
  });

  it('says when Mirror Buckets is paused in the Autonomy grid', async () => {
    store.bucketMirror.set({ account: gmail.id, source: 'gmail', enabled: true });
    store.autonomy.saveSettings({ ...store.autonomy.settings(), actions: { [MIRROR_BUCKETS]: 'off' } });
    renderFor(gmail);
    expect(
      await screen.findByText(/Paused: Mirror Buckets is below Auto in Settings → Autonomy/),
    ).toBeTruthy();
  });
});
