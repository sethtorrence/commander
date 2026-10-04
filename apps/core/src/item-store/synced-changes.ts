// How the Item store treats the synced fields of Source Items (see the domain's synced-fields.ts),
// so Two-way sync works field by field: an edit changes only the fields it names, undo restores only
// the fields its entry changed, every change made in Commander is queued for the Source in the same
// transaction, and a sync shows the Source's values with the changes still on their way on top.
import { isDeepStrictEqual } from 'node:util';
import {
  type ActivityEntry,
  type Item,
  type ItemDetail,
  type ItemState,
  isSyncedField,
  itemDetail,
  statusFromDetail,
  syncedFieldsOf,
  withSyncedFields,
} from '@commander/domain';
import type { OutgoingQueue } from './outgoing';

type Invalid = (message: string) => Error;

/** The state after an edit of some synced fields, the others as they are now. */
export function editedState(item: Item, fields: Record<string, unknown>, invalid: Invalid): ItemState {
  const current = syncedFieldsOf(item.detail);
  if (!item.detail || !current) throw invalid(`A ${item.kind} Item has no fields that sync to a Source`);
  const kind = item.detail.kind;
  const unknown = Object.keys(fields).filter((field) => !isSyncedField(kind, field));
  if (unknown.length) throw invalid(`Not a synced field of a ${kind} Item: ${unknown.join(', ')}`);
  const parsed = itemDetail.safeParse(withSyncedFields(item.detail, { ...current, ...fields }));
  if (!parsed.success) throw invalid(`That change doesn't fit a ${kind} Item: ${parsed.error.message}`);
  const { title, people, status, filing, deletedAt } = item;
  return {
    title,
    people,
    filing,
    deletedAt,
    detail: parsed.data,
    status: statusFromDetail(parsed.data, status),
  };
}

/**
 * The detail an undo restores: the synced fields the entry changed go back to what they were before
 * it, and everything else stays as it is now (a later sync's comments, say). null when the detail has
 * no synced fields, and undo restores it whole as for any other Item.
 */
export function undoneDetail(
  current: ItemDetail | null,
  before: ItemDetail | null,
  after: ItemDetail | null,
) {
  const now = syncedFieldsOf(current);
  const was = syncedFieldsOf(before);
  const then = syncedFieldsOf(after);
  if (!current || !now || !was || !then) return null;
  const restored = { ...now };
  for (const field of new Set([...Object.keys(was), ...Object.keys(then)])) {
    if (!isDeepStrictEqual(was[field] ?? null, then[field] ?? null)) restored[field] = was[field] ?? null;
  }
  return withSyncedFields(current, restored);
}

/** Queues each synced field a change made in Commander (not by the Source) changed on a Source Item. */
export function queueChanges(
  queue: OutgoingQueue,
  item: Item,
  before: ItemState,
  after: ItemState,
  entry: ActivityEntry,
) {
  if (entry.by.kind === 'source' || !item.source || !item.account || !item.externalId) return;
  const was = syncedFieldsOf(before.detail);
  const now = syncedFieldsOf(after.detail);
  if (!was || !now) return;
  for (const field of new Set([...Object.keys(was), ...Object.keys(now)])) {
    const value = now[field] ?? null;
    const synced = was[field] ?? null;
    if (isDeepStrictEqual(value, synced)) continue;
    queue.queue({
      account: item.account,
      source: item.source,
      itemId: item.id,
      externalId: item.externalId,
      field,
      value,
      synced,
      madeAt: entry.at,
      entryId: entry.id,
    });
  }
}

/**
 * The detail and status to save from a sync: the Source's, with the changes still queued for it on
 * top (so a sync never undoes an edit that hasn't reached the Source yet). Records the Source's values
 * as the queued changes' last-synced values, and drops queued changes the Source already has.
 */
export function withQueuedOnTop(
  queue: OutgoingQueue,
  itemId: string,
  incoming: Pick<ItemState, 'detail' | 'status'>,
): Pick<ItemState, 'detail' | 'status'> {
  const fields = syncedFieldsOf(incoming.detail);
  if (!incoming.detail || !fields) return incoming;
  const queued = queue.synced(itemId, fields);
  if (!queued.length) return incoming;
  const shown = { ...fields };
  for (const change of queued) shown[change.field] = change.value;
  const detail = withSyncedFields(incoming.detail, shown);
  return { detail, status: statusFromDetail(detail, incoming.status) };
}
