import {
  DRAFTS_FOCUS,
  type MessageView,
  OUTBOX_FOCUS,
  type OutgoingChange,
  type OutgoingEntry,
  SCHEDULED_FOCUS,
} from '@commander/domain';
import type { ItemStoreClient } from '../item-store/client';
import { clockTime } from './account-sync';

/*
  An Account's changes that didn't reach its Source, as Settings → Accounts shows them (#206): the
  waiting and Couldn't sync counts beside its sync status, and the list of each change (what it was,
  on which Item, when, and why it stopped) with Retry and Discard. A message written in Commander is
  looked after in the Email Section's Outbox, Scheduled or Drafts instead, so its change opens there.
*/

/** What Settings asks of the Core for the list, through the window's Item store channel. */
export interface OutgoingChangesClient {
  entries(account: string): Promise<OutgoingEntry[]>;
  retry(ids: number[]): Promise<OutgoingChange[]>;
  /** Puts the Items back as the Source has them; nothing is queued. */
  discard(ids: number[]): Promise<void>;
}

export function outgoingChangesIn(itemStore: ItemStoreClient): OutgoingChangesClient {
  return {
    entries: (account) => itemStore({ op: 'outgoing-entries', query: { account } }),
    retry: (ids) => itemStore({ op: 'retry-changes', ids }),
    async discard(ids) {
      await itemStore({ op: 'discard-changes', ids });
    },
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 changes waiting · 1 couldn’t sync", or null when nothing is queued. */
export function describeOutgoing({ pending, failed }: { pending: number; failed: number }): string | null {
  const parts = [
    ...(pending ? [`${plural(pending, 'change')} waiting`] : []),
    ...(failed ? [`${pending ? failed : plural(failed, 'change')} couldn’t sync`] : []),
  ];
  return parts.length ? parts.join(' · ') : null;
}

/** Where a change stands, in a few words: "Couldn’t sync", "Sending now…", "Waiting to sync". */
export function changeState(entry: Pick<OutgoingEntry, 'status' | 'attempts'>): string {
  if (entry.status === 'failed') return 'Couldn’t sync';
  if (entry.status === 'sending') return 'Sending now…';
  return entry.attempts > 0
    ? `Trying again (${plural(entry.attempts, 'failed attempt')})`
    : 'Waiting to sync';
}

/** "Made 14:02", or "Made 2 Oct 14:02" on another day. */
export const madeWhen = (entry: Pick<OutgoingEntry, 'madeAt'>, now: Date) =>
  `Made ${clockTime(entry.madeAt, now)}`;

/** Where the Email Section shows a message's change, and what its button says. */
export const MESSAGE_PLACES: Record<MessageView, { focus: string; label: string }> = {
  outbox: { focus: OUTBOX_FOCUS, label: 'Open the Outbox' },
  scheduled: { focus: SCHEDULED_FOCUS, label: 'Open Scheduled' },
  drafts: { focus: DRAFTS_FOCUS, label: 'Open Drafts' },
};
