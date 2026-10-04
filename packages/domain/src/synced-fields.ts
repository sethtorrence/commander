import type { ItemDetail, ItemKind, ItemStatus } from './items';
import type { LinearIssueDetail } from './linear';
import { type ChatDetail, type ChatReply, latestFromOthers } from './teams';

// Two-way sync's view of an Item's detail: the fields that write back to its Source, each keyed so
// it changes on its own. The User's edits, the outgoing queue, undo and the conflict rule (the newer
// change wins, per field) all work field by field through this view, so a change to one field never
// carries a stale copy of another.
//
// Linear issues: `state`, `assignee`, `priority`, `dueDate`, `estimate`, `cycle`, `linearProject`,
// one `label:<id>` per label (the label, or null once removed) and one `comment:<id>` per comment
// (the comment, or null once deleted). The description, title and team are not synced fields: they
// are read-only in Commander.
//
// Teams Chats (#106): `read` (whether the User has read it to the end) and one `message:<clientId>`
// per reply written in Commander that Teams doesn't have yet (the reply, or null once cancelled).
// Once Teams has a reply it is one of the Chat's messages, under Teams's id, and no longer a synced
// field: a message that reached other people can't be recalled (see isUnrecallableField).

export type SyncedFields = Record<string, unknown>;

const LINEAR_SCALARS = [
  'state',
  'assignee',
  'priority',
  'dueDate',
  'estimate',
  'cycle',
  'linearProject',
] as const satisfies readonly (keyof LinearIssueDetail)[];
type LinearScalar = (typeof LINEAR_SCALARS)[number];

export const LABEL_FIELD = 'label:';
export const COMMENT_FIELD = 'comment:';

const isScalar = (field: string): field is LinearScalar =>
  (LINEAR_SCALARS as readonly string[]).includes(field);

function linearIssueFields(detail: LinearIssueDetail): SyncedFields {
  const fields: SyncedFields = {};
  for (const field of LINEAR_SCALARS) fields[field] = detail[field];
  for (const label of detail.labels) fields[`${LABEL_FIELD}${label.id}`] = label;
  for (const comment of detail.comments) fields[`${COMMENT_FIELD}${comment.id}`] = comment;
  return fields;
}

function withLinearIssueFields(detail: LinearIssueDetail, fields: SyncedFields): LinearIssueDetail {
  const next: LinearIssueDetail = { ...detail };
  const labels: LinearIssueDetail['labels'] = [];
  const comments: LinearIssueDetail['comments'] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (isScalar(field)) Object.assign(next, { [field]: value });
    else if (field.startsWith(LABEL_FIELD) && value)
      labels.push(value as LinearIssueDetail['labels'][number]);
    else if (field.startsWith(COMMENT_FIELD) && value)
      comments.push(value as LinearIssueDetail['comments'][number]);
  }
  // In the order Linear sync keeps them: labels by name, comments oldest first.
  next.labels = labels.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  next.comments = comments.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return next;
}

export const READ_FIELD = 'read';
export const MESSAGE_FIELD = 'message:';

function chatFields(detail: ChatDetail): SyncedFields {
  const fields: SyncedFields = { [READ_FIELD]: detail.unreadCount === 0 };
  for (const reply of detail.replies ?? []) fields[`${MESSAGE_FIELD}${reply.clientId}`] = reply;
  return fields;
}

// Read to its latest message; or unread from the latest message someone else sent, as Teams marks it.
function withRead(detail: ChatDetail, read: unknown): ChatDetail {
  if (read === true && detail.unreadCount > 0) {
    const upTo = Math.max(detail.lastReadAt ?? 0, detail.lastMessageAt ?? 0);
    return { ...detail, lastReadAt: upTo, unreadCount: 0, mentionsMe: false };
  }
  if (read === false && detail.unreadCount === 0) {
    // Who the User is shows only when they spoke last: then it is that message's sender.
    const spoken = latestFromOthers(detail.messages, null);
    const me = detail.latestFromMe ? (spoken?.from?.userId ?? null) : null;
    const from = latestFromOthers(detail.messages, me);
    if (!from) return detail;
    return { ...detail, lastReadAt: from.createdAt - 1, unreadCount: 1 };
  }
  return detail;
}

function withChatFields(detail: ChatDetail, fields: SyncedFields): ChatDetail {
  const replies: ChatReply[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (field.startsWith(MESSAGE_FIELD) && value) replies.push(value as ChatReply);
  }
  const { replies: _replies, ...rest } = withRead(detail, fields[READ_FIELD]);
  if (!replies.length) return rest;
  replies.sort((a, b) => a.createdAt - b.createdAt || a.clientId.localeCompare(b.clientId));
  return { ...rest, replies };
}

const isChatField = (field: string) =>
  field === READ_FIELD || (field.startsWith(MESSAGE_FIELD) && field.length > MESSAGE_FIELD.length);

/** Whether `field` names one of a detail kind's synced fields. */
export function isSyncedField(kind: ItemDetail['kind'], field: string): boolean {
  if (kind === 'chat') return isChatField(field);
  if (kind !== 'linear-issue') return false;
  return (
    isScalar(field) ||
    (field.startsWith(LABEL_FIELD) && field.length > LABEL_FIELD.length) ||
    (field.startsWith(COMMENT_FIELD) && field.length > COMMENT_FIELD.length)
  );
}

/**
 * Whether a change to this synced field can't be taken back once the Source has it: a reply sent to
 * a Teams Chat has reached other people. Until then (queued, or Couldn't sync) undo cancels it.
 */
export function isUnrecallableField(kind: ItemKind, field: string): boolean {
  return kind === 'chat' && field.startsWith(MESSAGE_FIELD) && isChatField(field);
}

/** The detail's synced fields, or null for a kind that doesn't write back to a Source. */
export function syncedFieldsOf(detail: ItemDetail | null): SyncedFields | null {
  if (detail?.kind === 'linear-issue') return linearIssueFields(detail);
  if (detail?.kind === 'chat') return chatFields(detail);
  return null;
}

/**
 * The detail with `fields` in place of its synced fields: every synced field it should have, as
 * `syncedFieldsOf` gives them (a field missing from `fields`, or null, is a label or comment gone).
 */
export function withSyncedFields<D extends ItemDetail>(detail: D, fields: SyncedFields): D {
  if (detail.kind === 'linear-issue') return withLinearIssueFields(detail, fields) as D;
  if (detail.kind === 'chat') return withChatFields(detail, fields) as D;
  return detail;
}

/** The Item status a detail implies, for kinds where it follows a synced field (a closed Linear state). */
export function statusFromDetail(detail: ItemDetail | null, otherwise: ItemStatus): ItemStatus {
  if (detail?.kind !== 'linear-issue') return otherwise;
  return detail.state.type === 'completed' || detail.state.type === 'canceled' ? 'done' : 'open';
}
