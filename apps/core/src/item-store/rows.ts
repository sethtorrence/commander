// Translation between database rows and the domain shapes the Item store hands out.
import { isDeepStrictEqual } from 'node:util';
import type {
  ActivityEntry,
  Actor,
  CausedBy,
  Item,
  ItemChange,
  ItemDetail,
  ItemState,
} from '@commander/domain';
import type * as schema from './schema';

export type { ItemState } from '@commander/domain';

export type ItemRow = typeof schema.items.$inferSelect;
export type TodoDetailRow = typeof schema.todoDetails.$inferSelect;
export type DailyNoteDetailRow = typeof schema.dailyNoteDetails.$inferSelect;
export type BlockDetailRow = typeof schema.blockDetails.$inferSelect;
export type LinearIssueDetailRow = typeof schema.linearIssueDetails.$inferSelect;
export type ChatDetailRow = typeof schema.chatDetails.$inferSelect;
export type ChannelPostDetailRow = typeof schema.channelPostDetails.$inferSelect;
export type EventDetailRow = typeof schema.eventDetails.$inferSelect;
export type GitHubDetailRow = typeof schema.githubDetails.$inferSelect;
export type MeetingPrepDetailRow = typeof schema.meetingPrepDetails.$inferSelect;
export type ActivityRow = typeof schema.activity.$inferSelect;

export function stateOf(item: Item): ItemState {
  const { title, people, status, filing, detail, deletedAt } = item;
  return { title, people, status, filing, detail, deletedAt };
}

export function itemColumns(state: ItemState) {
  return {
    title: state.title,
    people: state.people,
    status: state.status,
    projectId: state.filing?.projectId ?? null,
    filedBy: state.filing?.filedBy ?? null,
    deletedAt: state.deletedAt,
  };
}

export const todoDetailOf = (todo: TodoDetailRow): ItemDetail => ({
  kind: 'todo',
  origin: todo.origin,
  dueOn: todo.dueOn,
  backedBy: todo.backedBy,
  ...(todo.fromMessage && { fromMessage: todo.fromMessage }),
});

export const dailyNoteDetailOf = (note: DailyNoteDetailRow): ItemDetail => ({
  kind: 'daily-note',
  day: note.day,
});

export const blockDetailOf = (block: BlockDetailRow): ItemDetail => ({
  kind: 'block',
  dailyNoteId: block.dailyNoteId,
  parentId: block.parentId,
  position: block.position,
  text: block.text,
  folded: block.folded,
});

export const linearIssueDetailOf = (issue: LinearIssueDetailRow): ItemDetail => ({
  kind: 'linear-issue',
  ...issue.data,
});

export const chatDetailOf = (chat: ChatDetailRow): ItemDetail => ({ kind: 'chat', ...chat.data });

export const channelPostDetailOf = (post: ChannelPostDetailRow): ItemDetail => ({
  kind: 'channel-post',
  ...post.data,
});

export const eventDetailOf = (event: EventDetailRow): ItemDetail => ({ kind: 'event', ...event.data });
export const githubDetailOf = (row: GitHubDetailRow): ItemDetail => row.data;

export const meetingPrepDetailOf = (prep: MeetingPrepDetailRow): ItemDetail => ({
  kind: 'meeting-prep',
  ...prep.data,
});

export function toItem(row: ItemRow, detail: ItemDetail | null): Item {
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    account: row.account,
    externalId: row.externalId,
    title: row.title,
    people: row.people,
    filing: row.projectId && row.filedBy ? { projectId: row.projectId, filedBy: row.filedBy } : null,
    status: row.status,
    detail,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

export function actorColumns(by: Actor): Pick<ActivityRow, 'actor' | 'actorRef'> {
  switch (by.kind) {
    case 'rule':
      return { actor: 'rule', actorRef: by.ruleId };
    case 'source':
      return { actor: 'source', actorRef: `${by.source}:${by.account}` };
    default:
      return { actor: by.kind, actorRef: null };
  }
}

function toActor(row: ActivityRow): Actor {
  const ref = row.actorRef ?? '';
  switch (row.actor) {
    case 'rule':
      return { kind: 'rule', ruleId: ref };
    case 'source': {
      const split = ref.indexOf(':');
      const source = ref.slice(0, split) as Extract<Actor, { kind: 'source' }>['source'];
      return { kind: 'source', source, account: ref.slice(split + 1) };
    }
    default:
      return { kind: row.actor };
  }
}

// An Item's own fields, in the order ItemState lists them: the only ones an activity entry reports as
// changes. Some entries also record Commander's own fields (an email's `bucket`, a Chat's `waiting`, a
// warning's `injectionWarning`) so they can be undone; those are no change to the Item itself, and the
// window refuses a reply naming them.
const STATE_FIELDS = [
  'title',
  'people',
  'status',
  'filing',
  'detail',
  'deletedAt',
] as const satisfies readonly (keyof ItemState)[];

// The fields that differ between two recorded states of an Item, in the order ItemState lists them.
export function changesBetween(before: ItemState, after: ItemState): ItemChange[] {
  return STATE_FIELDS.filter((field) => field in after || field in before)
    .filter((field) => !isDeepStrictEqual(before[field], after[field]))
    .map((field) => ({ field, before: before[field], after: after[field] }) as ItemChange);
}

export function toEntry(row: ActivityRow): ActivityEntry {
  let causedBy: CausedBy | null = null;
  if (row.causedByItemId || row.causedByEntryId) {
    causedBy = {};
    if (row.causedByItemId) causedBy.itemId = row.causedByItemId;
    if (row.causedByEntryId) causedBy.entryId = row.causedByEntryId;
  }
  return {
    id: row.id,
    at: row.at,
    by: toActor(row),
    action: row.action,
    itemId: row.itemId,
    otherItemId: row.otherItemId,
    otherProjectId: row.otherProjectId,
    why: row.why,
    causedBy,
    undoes: row.undoes,
    // A Link entry records the Link, and a creation has no state before it.
    changes:
      row.otherItemId === null && row.otherProjectId === null && row.before && row.after
        ? changesBetween(row.before as ItemState, row.after as ItemState)
        : [],
    ...(row.summary?.length ? { summaries: row.summary } : {}),
  };
}
