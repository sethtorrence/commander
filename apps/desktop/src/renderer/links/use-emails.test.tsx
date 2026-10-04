// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { EmailDetail, SourceItem } from '@commander/domain';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ItemChanges } from '../item-store/changes';
import type { ItemStoreClient } from '../item-store/client';
import { openTestItemStore } from '../item-store/test-item-store';
import { useEmails } from './use-emails';

// The emails `[[` links read (#135): those the picker offers and those linked on screen.

const T = Date.UTC(2026, 9, 3, 9);
let store: ItemStore;
let client: ItemStoreClient;
let changes: ItemChanges;
let close: () => void;

beforeEach(() => {
  ({ store, client, changes, close } = openTestItemStore());
});

afterEach(() => {
  cleanup();
  close();
});

function email(externalId: string, subject: string, fields: Partial<EmailDetail> = {}): SourceItem {
  const detail: EmailDetail = {
    kind: 'email',
    messageId: `<${externalId}@mail.test>`,
    inReplyTo: null,
    references: [],
    threadKey: `mid:<${externalId}@mail.test>`,
    sourceThreadId: null,
    from: { name: 'Dana Whitfield', address: 'dana@northwind.test' },
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject,
    sentAt: T,
    snippet: '',
    read: true,
    starred: false,
    inInbox: true,
    sentByMe: false,
    labels: fields.inInbox === false ? [] : [{ id: 'INBOX', name: 'Inbox' }],
    attachments: [],
    hasInvitation: false,
    listUnsubscribe: null,
    listId: null,
    ...fields,
  };
  return { externalId, kind: 'email', title: subject, people: [], status: 'open', detail };
}

const save = (items: SourceItem[], deleted: string[] = []) =>
  store.saveFromSource({ source: 'gmail', account: 'google:alex', items, deleted });
const idOf = (subject: string) => store.query({ kinds: ['email'], titleContains: subject })[0]?.id as string;

describe('useEmails', () => {
  it('offers mail in the inbox and the archive, and reads the emails linked on screen, gone ones too', async () => {
    save([email('a', 'Q4 budget'), email('b', 'Offsite venue', { inInbox: false }), email('c', 'Old news')]);
    const old = idOf('Old news');
    save([], ['c']);

    const { result } = renderHook(() => useEmails(client, [old], { changes }));

    await waitFor(() =>
      expect(result.current.offered.map((item) => item.title).sort()).toEqual(['Offsite venue', 'Q4 budget']),
    );
    await waitFor(() => expect(result.current.byId.get(old)?.deletedAt).not.toBeNull());
    expect(result.current.byId.get(idOf('Q4 budget'))?.title).toBe('Q4 budget');
  });

  it('reads a linked email again when it changes', async () => {
    save([email('a', 'Q4 budget')]);
    const budget = idOf('Q4 budget');
    const { result } = renderHook(() => useEmails(client, [budget], { changes }));
    await waitFor(() => expect(result.current.byId.get(budget)?.deletedAt).toBeNull());

    // A change from the window (the Core says which Items changed): deleting it.
    await client({ op: 'record', action: { type: 'delete', itemId: budget } });

    await waitFor(() => expect(result.current.byId.get(budget)?.deletedAt).not.toBeNull());
    await waitFor(() => expect(result.current.offered).toEqual([]));
  });
});
