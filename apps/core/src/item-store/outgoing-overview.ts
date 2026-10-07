// Changes that didn't reach a Source, as Settings → Accounts lists them (#206): each queued change in
// Commander's own words (the domain's outgoing-words.ts), on which Item, when and why it stopped; and
// Discard, which takes changes out of the queue and puts their Items back as the Source has them,
// without queueing anything: a synced field goes back to the value the Source last had, a deletion
// that never went is taken back, an Item made in Commander that the Source never had goes (a
// tombstone, with everything queued for it), and an event Commander made goes back to the time the
// Source has. Each Discard is one activity entry per Item, as the User's. A message written in
// Commander (its draft, its sending) is never discarded here: the Outbox, Scheduled and Drafts look
// after it, with their own Retry and Undo.
import {
  type ActivityEntry,
  type Actor,
  CANCEL_SEND_FIELD,
  type CommanderEventMove,
  CREATE_FIELD,
  changeWords,
  DELETE_FIELD,
  DRAFT_FIELD,
  discardedWhy,
  ITEM_KIND_OF_SOURCE,
  type Item,
  type ItemState,
  isSyncedField,
  type MessageView,
  MOVE_FIELD,
  type OutgoingEntriesQuery,
  type OutgoingEntry,
  outgoingEntriesQuery,
  SEND_FIELD,
  SOURCE_NAME_OF,
  statusFromDetail,
  syncedFieldsOf,
  withSyncedFields,
} from '@commander/domain';
import type { ComposeRecord } from './compose';
import type { OutgoingQueue, OutgoingRow } from './outgoing';
import { stateOf } from './rows';

type Entry = { by: Actor; why?: string | null };

export type OutgoingOverviewDeps = {
  outgoing: OutgoingQueue;
  readItem(id: string): Item | undefined;
  // The Item before the activity entry that queued a change, for an event moved before its Source's
  // time was kept with the change.
  stateBefore(entryId: number): ItemState | null;
  compose(itemId: string): ComposeRecord | null;
  writeState(item: Item, state: ItemState, at: number): ItemState;
  log(
    entry: Entry & { action: 'update' | 'delete'; itemId: string; before: ItemState; after: ItemState },
    at: number,
  ): ActivityEntry;
  // What follows a change to an Item (a Linear issue's Todo follows its state).
  afterChange(item: Item, before: ItemState, after: ItemState, entry: ActivityEntry): void;
  invalid(message: string): Error;
};

const MESSAGE_FIELDS = new Set([DRAFT_FIELD, SEND_FIELD, CANCEL_SEND_FIELD, DELETE_FIELD]);

/** The Source's short name for an Item, when it has one (ENG-418). */
const labelOf = (item: Item | undefined) =>
  item?.detail?.kind === 'linear-issue' ? item.detail.identifier : null;

export function outgoingOverviewIn(deps: OutgoingOverviewDeps) {
  const { outgoing } = deps;

  // Where the Outbox looks after a change to a message written in Commander, or null for any other.
  function messageOf(row: Pick<OutgoingRow, 'itemId' | 'field'>, item: Item | undefined): MessageView | null {
    if (item?.kind !== 'email' || !MESSAGE_FIELDS.has(row.field)) return null;
    const record = deps.compose(row.itemId);
    if (row.field === DRAFT_FIELD) return 'drafts';
    // A draft discarded in Commander, still to go from the Source's Drafts.
    if (row.field === DELETE_FIELD) return record ? 'drafts' : null;
    if (row.field === CANCEL_SEND_FIELD) return 'scheduled';
    return record?.scheduledAt != null ? 'scheduled' : 'outbox';
  }

  const wordsOf = (row: OutgoingRow, item: Item | undefined) =>
    changeWords(row, { kind: item?.kind ?? ITEM_KIND_OF_SOURCE[row.source], source: row.source });

  // The time the Source has for an event Commander made, before the change moved it.
  function timeBefore(row: OutgoingRow, item: Item): CommanderEventMove | null {
    const kept = row.synced as CommanderEventMove | null;
    if (kept?.start && kept.end) return kept;
    // Moved before the time was kept with the change: the entry that queued it says what it was.
    const before = row.entryId !== null ? deps.stateBefore(row.entryId) : null;
    const detail = before?.detail ?? null;
    if (detail?.kind !== 'event' || item.detail?.kind !== 'event') return null;
    return { start: detail.start, end: detail.end, allDay: detail.allDay };
  }

  // The Item as the Source has it, without these changes (none of them on its way, none a message).
  function restored(item: Item, rows: OutgoingRow[], at: number): ItemState {
    const state = stateOf(item);
    if (rows.some((row) => row.field === CREATE_FIELD)) return { ...state, deletedAt: state.deletedAt ?? at };
    let next: ItemState = state;
    const fields: Record<string, unknown> = {};
    for (const row of rows) {
      if (row.field === DELETE_FIELD) {
        // Deleting that never went: the Item stays; taking back a deletion that did go: it is gone.
        next = { ...next, deletedAt: row.value === null ? (next.deletedAt ?? at) : null };
      } else if (row.field === MOVE_FIELD) {
        const time = timeBefore(row, item);
        if (time && next.detail?.kind === 'event') next = { ...next, detail: { ...next.detail, ...time } };
      } else if (item.detail && isSyncedField(item.detail.kind, row.field)) {
        fields[row.field] = row.synced ?? null;
      }
    }
    if (!Object.keys(fields).length || !next.detail) return next;
    const detail = withSyncedFields(next.detail, { ...(syncedFieldsOf(next.detail) ?? {}), ...fields });
    return { ...next, detail, status: statusFromDetail(detail, next.status) };
  }

  return {
    /** The queued changes of one Account (or all), oldest first, in Commander's words. */
    entries(input: OutgoingEntriesQuery = {}): OutgoingEntry[] {
      const query = outgoingEntriesQuery.parse(input);
      return outgoing.rows(query.account ? { account: query.account } : {}).map((row) => {
        const item = deps.readItem(row.itemId);
        return {
          id: row.id,
          itemId: row.itemId,
          source: row.source,
          account: row.account,
          field: row.field,
          status: row.status,
          madeAt: row.madeAt,
          attempts: row.attempts,
          error: row.error,
          what: wordsOf(row, item).what,
          item: {
            title: item?.title ?? 'Gone from Commander',
            label: labelOf(item),
            kind: item?.kind ?? ITEM_KIND_OF_SOURCE[row.source],
          },
          message: messageOf(row, item),
        };
      });
    },

    /**
     * Discards changes: out of the queue, their Items back as the Source has them, nothing queued.
     * Refused for a change on its way, and for a message's (the Outbox looks after those). An Item
     * made in Commander that the Source never had goes, with everything queued for it. Runs inside a
     * transaction.
     */
    discard(ids: number[], entry: Entry, at: number): ActivityEntry[] {
      const rows = outgoing.rows({ ids });
      if (!rows.length) throw deps.invalid('Those changes are no longer waiting to sync');
      const byItem = new Map<string, OutgoingRow[]>();
      for (const row of rows) byItem.set(row.itemId, [...(byItem.get(row.itemId) ?? []), row]);
      const logged: ActivityEntry[] = [];
      for (const [itemId, chosen] of byItem) {
        const item = deps.readItem(itemId);
        const source = SOURCE_NAME_OF[chosen[0]?.source ?? 'linear'];
        if (chosen.some((row) => row.status === 'sending'))
          throw deps.invalid(`That change is on its way to ${source}, so it can’t be discarded now`);
        if (chosen.some((row) => messageOf(row, item)))
          throw deps.invalid('A message is taken back from the Outbox, or discarded from Drafts');
        // The Source never had the Item: whatever else is queued for it goes too.
        const creating = chosen.some((row) => row.field === CREATE_FIELD);
        const dropped = creating ? outgoing.forItem(itemId) : chosen;
        if (dropped.some((row) => row.status === 'sending'))
          throw deps.invalid(`That Item is on its way to ${source}, so it can’t be discarded now`);
        outgoing.discard(dropped.map((row) => row.id));
        if (!item) continue;
        const before = stateOf(item);
        const after = deps.writeState(item, restored(item, chosen, at), at);
        const what = chosen.map((row) => wordsOf(row, item).what).join('; ');
        const done = deps.log(
          {
            ...entry,
            why: discardedWhy(what, chosen[0]?.source ?? 'linear'),
            action: after.deletedAt !== null && before.deletedAt === null ? 'delete' : 'update',
            itemId,
            before,
            after,
          },
          at,
        );
        deps.afterChange(item, before, after, done);
        logged.push(done);
      }
      return logged;
    },
  };
}
