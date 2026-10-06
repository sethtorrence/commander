// Skip the inbox (#142, decision #16): mail a Rule or Ares sorts into a Bucket set to skip the inbox
// (Settings → Buckets) is archived at its Source through the gate, as Tidy your Sources / "Skip the
// inbox": at Ask (the default) a suggestion on the email, grouped in the Bucket view with Accept all;
// at Auto archived on arrival, as Ares, undoably. The User's own sort into such a Bucket is archived at
// once by the Item store as part of their change, so it never comes here. Archiving is the `inbox`
// synced field (#135, #136), so undo brings the email back to the inbox.
//
// - Offered once per sort: a suggestion waiting, or one already settled for the same sort (its cause),
//   is never made again, so a dismissed one stays dismissed.
// - Switching a Bucket's Skip the inbox on offers the mail already in it and still in the inbox, only
//   ever as suggestions (the User chose to skip mail as it arrives, not to archive what they hold).
//
// Mirror Buckets (Tidy your Sources too) is registered here beside it: the Item store writes the labels
// while an Account mirrors, and pauses below Auto in the grid.
import {
  type ActivityEntry,
  type EmailDetail,
  type Item,
  MIRROR_BUCKETS,
  type RegisteredAction,
  SKIP_THE_INBOX,
} from '@commander/domain';
import type { Gate } from '../autonomy/gate';
import type { ItemStore } from '../item-store';

export const SKIP_THE_INBOX_ACTION: RegisteredAction = {
  action: SKIP_THE_INBOX,
  actionKind: 'tidy-sources',
  name: 'Skip the inbox',
  hint: 'Archives mail a Rule or Ares sorts into a Bucket set to skip the inbox (Settings → Buckets)',
};

export const MIRROR_BUCKETS_ACTION: RegisteredAction = {
  action: MIRROR_BUCKETS,
  actionKind: 'tidy-sources',
  name: 'Mirror Buckets',
  hint: 'Commander labels in Gmail and categories in Outlook, for Accounts that mirror their Buckets (Settings → Accounts). Below Auto nothing is written.',
};

export type SkipInbox = {
  // Looks at these Items (just synced, sorted or changed): an email a Rule or Ares sorted into a Bucket
  // that skips the inbox, still in it, gets its proposal. Returns the Items whose suggestions changed.
  consider(itemIds: readonly string[]): string[];
  // A Bucket's Skip the inbox was switched on: its mail still in the inbox is offered, as suggestions.
  bucketSwitchedOn(bucketId: string): string[];
};

const emailOf = (item: Item | undefined): EmailDetail | null =>
  item?.detail?.kind === 'email' ? item.detail : null;

export function setUpSkipInbox({
  store,
  gate,
  log = (message) => console.warn(message),
}: {
  store: ItemStore;
  gate: Pick<Gate, 'registerAction' | 'propose'>;
  log?: (message: string) => void;
}): SkipInbox {
  gate.registerAction(SKIP_THE_INBOX_ACTION);
  gate.registerAction(MIRROR_BUCKETS_ACTION);

  // The entry that put the email in its Bucket: its latest change into it.
  function sortEntry(itemId: string, bucketId: string): ActivityEntry | undefined {
    const bucketOf = (detail: unknown) =>
      (detail as EmailDetail | null | undefined)?.bucket?.bucketId ?? null;
    return store
      .activity({ itemId, limit: 100 })
      .find((entry) =>
        entry.changes.some(
          (change) =>
            change.field === 'detail' &&
            bucketOf(change.after) === bucketId &&
            bucketOf(change.before) !== bucketId,
        ),
      );
  }

  function offered(itemId: string, cause: number | undefined): boolean {
    return store.autonomy
      .proposals({ itemId, action: SKIP_THE_INBOX })
      .some(
        (record) =>
          record.status === 'pending' || (cause !== undefined && record.causedBy?.entryId === cause),
      );
  }

  function propose(item: Item, bucketName: string, cause: number | undefined, askOnly: boolean): boolean {
    try {
      const outcome = gate.propose(
        {
          actionKind: 'tidy-sources',
          action: SKIP_THE_INBOX,
          section: 'email',
          itemId: item.id,
          itemActions: [{ type: 'edit-fields', itemId: item.id, fields: { inbox: false } }],
          confidence: 1,
          reason: `${bucketName} skips the inbox`,
          ...(cause !== undefined ? { causedBy: { entryId: cause } } : {}),
        },
        { askOnly },
      );
      return outcome.decision !== 'off';
    } catch (error) {
      log(`Couldn’t offer to archive an email that skips the inbox: ${String(error)}`);
      return false;
    }
  }

  const inTheInbox = (item: Item | undefined, detail: EmailDetail | null): detail is EmailDetail =>
    !!item && item.deletedAt === null && !!detail && detail.inInbox && !detail.inTrash;

  return {
    consider(itemIds) {
      const skipping = new Map(
        store
          .buckets()
          .filter((bucket) => bucket.skipInbox)
          .map((bucket) => [bucket.id, bucket]),
      );
      if (!skipping.size) return [];
      const changed: string[] = [];
      for (const itemId of new Set(itemIds)) {
        const item = store.get(itemId)?.item;
        const detail = emailOf(item);
        if (!item || !inTheInbox(item, detail)) continue;
        const sorted = detail.bucket;
        const bucket = sorted?.bucketId ? skipping.get(sorted.bucketId) : undefined;
        // The User's own sort was archived with it, or they took it back to the inbox since.
        if (!bucket || sorted?.sortedBy === 'user') continue;
        const cause = sortEntry(item.id, bucket.id)?.id;
        if (offered(item.id, cause)) continue;
        if (propose(item, bucket.name, cause, false)) changed.push(item.id);
      }
      return changed;
    },

    bucketSwitchedOn(bucketId) {
      const bucket = store.buckets().find((each) => each.id === bucketId);
      if (!bucket?.skipInbox) return [];
      const changed: string[] = [];
      // The Bucket's threads in the inbox (at most 2,000: a bounded batch of suggestions), message by message.
      const threads = store.emailThreads({ view: 'inbox', bucket: bucketId, limit: 2000 }).threads;
      for (const itemId of threads.flatMap((thread) => thread.itemIds)) {
        const item = store.get(itemId)?.item;
        const detail = emailOf(item);
        if (!item) continue;
        if (!inTheInbox(item, detail) || detail.bucket?.bucketId !== bucketId) continue;
        const cause = sortEntry(item.id, bucketId)?.id;
        if (offered(item.id, undefined)) continue;
        if (propose(item, bucket.name, cause, true)) changed.push(item.id);
      }
      return changed;
    },
  };
}
