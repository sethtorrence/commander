// Translation between database rows and the domain shapes the Item store hands out.
import type { ActivityEntry, Actor, CausedBy, Item, ItemDetail } from '@commander/domain';
import type * as schema from './schema';

export type ItemRow = typeof schema.items.$inferSelect;
export type TodoDetailRow = typeof schema.todoDetails.$inferSelect;
export type ActivityRow = typeof schema.activity.$inferSelect;

// The part of an Item that changes, and that the activity log records before and after each change.
export type ItemState = Pick<Item, 'title' | 'people' | 'status' | 'filing' | 'detail' | 'deletedAt'>;

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

export function toItem(row: ItemRow, todo: TodoDetailRow | undefined): Item {
  let detail: ItemDetail | null = null;
  if (row.kind === 'todo' && todo) detail = { kind: 'todo', dueOn: todo.dueOn, backedBy: todo.backedBy };
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
    why: row.why,
    causedBy,
    undoes: row.undoes,
  };
}
