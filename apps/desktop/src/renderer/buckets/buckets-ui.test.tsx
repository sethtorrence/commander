// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { EmailDetail } from '@commander/domain';
import { Toaster } from '@commander/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ItemStoreClient } from '../item-store/client';
import { openTestItemStore } from '../item-store/test-item-store';
import { BucketsSettings } from './BucketsSettings';

// Settings → Buckets in the window (#137), against a real Item store on a temporary database.
let store: ItemStore;
let client: ItemStoreClient;
let close: () => void;

beforeEach(() => {
  ({ store, client, close } = openTestItemStore());
});

afterEach(() => {
  cleanup();
  close();
});

function renderSettings() {
  render(
    <>
      <BucketsSettings no="18" itemStore={client} />
      <Toaster />
    </>,
  );
}

const names = () => store.buckets().map((bucket) => bucket.name);
const rows = () => within(screen.getByRole('list', { name: 'Buckets' })).getAllByRole('listitem');

describe('Settings → Buckets', () => {
  it('lists the starter Buckets with their descriptions, and explains that Ares sorts by them', async () => {
    renderSettings();
    expect(await screen.findByRole('textbox', { name: 'Name of Needs reply' })).toBeTruthy();
    expect(rows()).toHaveLength(7);
    expect(
      (screen.getByRole('textbox', { name: 'Description of Junk' }) as HTMLTextAreaElement).value,
    ).toMatch(/^Not useful in any way/);
    const group = screen.getByRole('region', { name: /Buckets/ });
    expect(group.textContent).toContain('Ares sorts');
    expect(group.textContent).toContain('Automated emails never need a reply.');
  });

  it('renames a Bucket and edits its description', async () => {
    renderSettings();
    const name = await screen.findByRole('textbox', { name: 'Name of FYI' });
    fireEvent.change(name, { target: { value: 'Good to know' } });
    fireEvent.blur(name);
    await waitFor(() => expect(names()).toContain('Good to know'));
    const description = await screen.findByRole('textbox', { name: 'Description of Good to know' });
    fireEvent.change(description, { target: { value: 'Nothing for me to do.' } });
    fireEvent.blur(description);
    await waitFor(() =>
      expect(store.buckets().find((bucket) => bucket.id === 'fyi')?.description).toBe(
        'Nothing for me to do.',
      ),
    );
  });

  it('adds a Bucket and reorders', async () => {
    renderSettings();
    await screen.findByRole('textbox', { name: 'Name of FYI' });
    fireEvent.change(screen.getByRole('textbox', { name: 'New Bucket name' }), {
      target: { value: 'Travel' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'New Bucket description' }), {
      target: { value: 'Flights, hotels and itineraries.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Bucket' }));
    await waitFor(() => expect(names().at(-1)).toBe('Travel'));
    expect(await screen.findByRole('textbox', { name: 'Name of Travel' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Move Travel up' }));
    await waitFor(() => expect(names().slice(-2)).toEqual(['Travel', 'Junk']));
  });

  it('removes a Bucket, its emails becoming Unsorted, and Undo brings it back', async () => {
    store.saveFromSource({
      source: 'gmail',
      account: 'google:alex',
      items: [
        {
          externalId: 'm1',
          kind: 'email',
          title: 'Your receipt',
          detail: {
            kind: 'email',
            messageId: '<m1@mail.test>',
            inReplyTo: null,
            references: [],
            threadKey: 'mid:<m1@mail.test>',
            sourceThreadId: null,
            from: { name: 'Shop', address: 'orders@shop.test' },
            to: [],
            cc: [],
            bcc: [],
            replyTo: [],
            subject: 'Your receipt',
            sentAt: 1,
            snippet: '',
            read: true,
            starred: false,
            inInbox: true,
            sentByMe: false,
            labels: [{ id: 'INBOX', name: 'Inbox' }],
            attachments: [],
            hasInvitation: false,
            listUnsubscribe: null,
            listId: null,
          },
        },
      ],
    });
    const email = store.query({ kinds: ['email'] })[0];
    store.record(
      {
        type: 'edit-fields',
        itemId: email?.id ?? '',
        fields: { bucket: { bucketId: 'receipts', sortedBy: 'user' } },
      },
      { by: { kind: 'user' } },
    );
    const bucketOfEmail = () =>
      (store.query({ kinds: ['email'] })[0]?.detail as EmailDetail | undefined)?.bucket ?? null;

    renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Receipts' }));
    await waitFor(() => expect(names()).not.toContain('Receipts'));
    expect(bucketOfEmail()).toBeNull();
    const toast = await screen.findByText(/Removed Receipts\. Its 1 email is Unsorted/);
    fireEvent.click(
      within(toast.closest('[data-sonner-toast]') as HTMLElement).getByRole('button', { name: 'Undo' }),
    );
    await waitFor(() => expect(names()).toContain('Receipts'));
    expect(bucketOfEmail()).toEqual({ bucketId: 'receipts', sortedBy: 'user' });
    expect(await screen.findByRole('textbox', { name: 'Name of Receipts' })).toBeTruthy();
  });
});

describe('Skip the inbox (#142)', () => {
  const skipSwitch = (name: string) => screen.getByRole('switch', { name: `${name} skips the inbox` });

  it('is off for every Bucket, suggested for Newsletters, Receipts and Junk', async () => {
    renderSettings();
    await screen.findByRole('textbox', { name: 'Name of FYI' });
    for (const bucket of store.buckets())
      expect(skipSwitch(bucket.name).getAttribute('aria-checked')).toBe('false');
    const suggested = rows()
      .filter((row) => within(row).queryByText(/Suggested/))
      .map((row) => within(row).getByRole('switch').getAttribute('aria-label'));
    expect(suggested).toEqual([
      'Newsletters skips the inbox',
      'Receipts skips the inbox',
      'Junk skips the inbox',
    ]);
    expect(screen.getByRole('region', { name: /Buckets/ }).textContent).toContain(
      'archived in Gmail or Outlook',
    );
  });

  it('switching it on saves it, and says what it does', async () => {
    renderSettings();
    await screen.findByRole('textbox', { name: 'Name of Newsletters' });
    fireEvent.click(skipSwitch('Newsletters'));
    await waitFor(() =>
      expect(store.buckets().find((bucket) => bucket.id === 'newsletters')?.skipInbox).toBe(true),
    );
    expect(await screen.findByText(/Newsletters now skips the inbox/)).toBeTruthy();
    await waitFor(() => expect(skipSwitch('Newsletters').getAttribute('aria-checked')).toBe('true'));
  });
});
