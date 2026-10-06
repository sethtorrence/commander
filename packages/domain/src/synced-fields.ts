import { BUCKET_FIELD, type EmailBucket } from './buckets';
import type { EventDetail, EventResponse } from './calendar';
import {
  type EmailDetail,
  type EmailFolder,
  type EmailLabel,
  type EmailSnooze,
  emailStatus,
  isSystemFolder,
} from './email';
import { canAnswer } from './invitations';
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
//
// Calendar events (#129): only an invitation (an event the User is a guest of, not its organiser)
// has synced fields: `response`, the User's answer, and for an instance of a series `seriesResponse`,
// their answer to the whole series. Everything else about an event is changed in Google Calendar or
// Outlook (Edit hands over to them).
//
// Emails (#135), one Item per message: `inbox`, `read`, `starred`, `trash` and one `label:<id>` per
// label beside those (the label, or null once removed), kept in step with the Source's labels (Gmail's
// INBOX, UNREAD, STARRED and TRASH; the ones Commander can't change, like SENT, stay as they are).
// `snooze` and `bucket` (#137) are Commander's own (local fields): edited, logged and undone like the
// others, kept through syncs, but never queued for the Source. Outlook's mail (#136) has `folder` (the
// folder it is filed in) instead of labels: `inbox` is the Inbox folder, `trash` Deleted Items,
// `starred` its flag.

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

const RESPONSE_FIELD = 'response';
const SERIES_RESPONSE_FIELD = 'seriesResponse';

function eventFields(detail: EventDetail): SyncedFields | null {
  if (!canAnswer(detail)) return null;
  const fields: SyncedFields = { [RESPONSE_FIELD]: detail.myResponse };
  if (detail.seriesId) fields[SERIES_RESPONSE_FIELD] = detail.seriesResponse ?? detail.myResponse;
  return fields;
}

function withEventFields(detail: EventDetail, fields: SyncedFields): EventDetail {
  const response = (fields[RESPONSE_FIELD] ?? detail.myResponse) as EventResponse | null;
  const next: EventDetail = {
    ...detail,
    myResponse: response,
    // The User's own line among the guests says the same.
    attendees: detail.attendees.map((each) => (each.self && response ? { ...each, response } : each)),
  };
  delete next.seriesResponse;
  const series = fields[SERIES_RESPONSE_FIELD] as EventResponse | null | undefined;
  if (detail.seriesId && series) next.seriesResponse = series;
  return next;
}

const INBOX_FIELD = 'inbox';
const STARRED_FIELD = 'starred';
const TRASH_FIELD = 'trash';
export const SNOOZE_FIELD = 'snooze';
export const FOLDER_FIELD = 'folder';
const EMAIL_FLAGS = [INBOX_FIELD, READ_FIELD, STARRED_FIELD, TRASH_FIELD, SNOOZE_FIELD, BUCKET_FIELD];
// Commander's own email fields: never queued for the Source. (Mirroring Buckets to Gmail labels and
// Outlook categories, #142, is a switch that is off by default.)
const LOCAL_EMAIL_FIELDS = new Set([SNOOZE_FIELD, BUCKET_FIELD]);
// The Source labels behind the flags, with the names Gmail gives them.
const FLAG_LABELS: Record<string, string> = {
  INBOX: 'Inbox',
  UNREAD: 'Unread',
  STARRED: 'Starred',
  TRASH: 'Trash',
};
// Labels Commander never changes: they stay on a message whatever its fields say.
const FIXED_LABELS = new Set(['SENT', 'DRAFT', 'SPAM', 'CHAT']);

/** Whether a Source label is one of an email's own labels (`label:<id>`), not a flag or a fixed one. */
export const isEmailLabelField = (labelId: string) => !(labelId in FLAG_LABELS) && !FIXED_LABELS.has(labelId);

// An Outlook folder as the `folder` field holds it, always in the same shape so values compare equal.
const folderValue = (folder: EmailFolder | null | undefined): EmailFolder | null =>
  folder ? { id: folder.id, name: folder.name, wellKnown: folder.wellKnown ?? null } : null;

/** Whether the detail is an Outlook message's (#136): filed in one folder rather than labelled. */
export const isOutlookEmail = (detail: EmailDetail) => detail.folder !== undefined;

function emailFields(detail: EmailDetail): SyncedFields {
  const fields: SyncedFields = {
    [INBOX_FIELD]: detail.inInbox,
    [READ_FIELD]: detail.read,
    [STARRED_FIELD]: detail.starred,
    [TRASH_FIELD]: detail.inTrash ?? false,
    [SNOOZE_FIELD]: detail.snooze ?? null,
    [BUCKET_FIELD]: detail.bucket ?? null,
  };
  if (isOutlookEmail(detail)) {
    fields[FOLDER_FIELD] = folderValue(detail.folder);
    return fields;
  }
  for (const label of detail.labels)
    if (isEmailLabelField(label.id)) fields[`${LABEL_FIELD}${label.id}`] = { id: label.id, name: label.name };
  return fields;
}

// Outlook (#136): the folder field files it, and it shows as the message's label unless it is one of
// Outlook's own folders. Trash is Deleted Items, on top of the folder it came from.
function withOutlookFields(detail: EmailDetail, fields: SyncedFields): EmailDetail {
  const folder = folderValue(fields[FOLDER_FIELD] as EmailFolder | null | undefined);
  const next: EmailDetail = {
    ...detail,
    inInbox: fields[INBOX_FIELD] as boolean,
    read: fields[READ_FIELD] as boolean,
    starred: fields[STARRED_FIELD] as boolean,
    folder,
    labels: folder && !isSystemFolder(folder) ? [{ id: folder.id, name: folder.name }] : [],
  };
  return withTrashAndLocal(next, fields);
}

// Trash and Commander's own fields (snooze, bucket), the same for every email Source.
function withTrashAndLocal(next: EmailDetail, fields: SyncedFields): EmailDetail {
  delete next.inTrash;
  delete next.snooze;
  delete next.bucket;
  if (fields[TRASH_FIELD] === true) next.inTrash = true;
  const snooze = fields[SNOOZE_FIELD] as EmailSnooze | null | undefined;
  if (snooze) next.snooze = snooze;
  const bucket = fields[BUCKET_FIELD] as EmailBucket | null | undefined;
  if (bucket) next.bucket = bucket;
  return next;
}

function withEmailFields(detail: EmailDetail, fields: SyncedFields): EmailDetail {
  if (isOutlookEmail(detail)) return withOutlookFields(detail, fields);
  const flags = {
    INBOX: fields[INBOX_FIELD] === true,
    UNREAD: fields[READ_FIELD] === false,
    STARRED: fields[STARRED_FIELD] === true,
    TRASH: fields[TRASH_FIELD] === true,
  };
  const wanted = new Map<string, EmailLabel>();
  for (const label of detail.labels) if (FIXED_LABELS.has(label.id)) wanted.set(label.id, label);
  for (const [id, on] of Object.entries(flags)) {
    if (on)
      wanted.set(id, detail.labels.find((label) => label.id === id) ?? { id, name: FLAG_LABELS[id] ?? id });
  }
  for (const [field, value] of Object.entries(fields)) {
    if (!field.startsWith(LABEL_FIELD) || !value) continue;
    const label = value as EmailLabel;
    wanted.set(label.id, { id: label.id, name: label.name });
  }
  // Labels it had keep their place (so an unchanged set compares equal); new ones go after.
  const kept = detail.labels.filter((label) => wanted.has(label.id)).map((label) => wanted.get(label.id));
  const added = [...wanted.values()].filter((label) => !detail.labels.some((each) => each.id === label.id));
  const next: EmailDetail = {
    ...detail,
    inInbox: fields[INBOX_FIELD] as boolean,
    read: fields[READ_FIELD] as boolean,
    starred: fields[STARRED_FIELD] as boolean,
    labels: [...kept, ...added] as EmailLabel[],
  };
  return withTrashAndLocal(next, fields);
}

const isEmailField = (field: string) =>
  EMAIL_FLAGS.includes(field) ||
  field === FOLDER_FIELD ||
  (field.startsWith(LABEL_FIELD) && field.length > LABEL_FIELD.length);

/** Whether `field` names one of a detail kind's synced fields. */
export function isSyncedField(kind: ItemDetail['kind'], field: string): boolean {
  if (kind === 'chat') return isChatField(field);
  if (kind === 'email') return isEmailField(field);
  if (kind === 'event') return field === RESPONSE_FIELD || field === SERIES_RESPONSE_FIELD;
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

/**
 * Whether a synced field is Commander's own (an email's snooze or Bucket): changed, logged and undone field by
 * field like the others, kept through syncs, but never queued for the Source.
 */
export function isLocalField(kind: ItemKind, field: string): boolean {
  return kind === 'email' && LOCAL_EMAIL_FIELDS.has(field);
}

/** The detail's own (local) fields among its synced fields, as syncedFieldsOf gives them. */
export function localFieldsOf(detail: ItemDetail | null): SyncedFields {
  const fields = syncedFieldsOf(detail) ?? {};
  return Object.fromEntries(
    Object.entries(fields).filter(([field]) => detail && isLocalField(detail.kind, field)),
  );
}

/** The detail's synced fields, or null for a kind that doesn't write back to a Source. */
export function syncedFieldsOf(detail: ItemDetail | null): SyncedFields | null {
  if (detail?.kind === 'email') return emailFields(detail);
  if (detail?.kind === 'linear-issue') return linearIssueFields(detail);
  if (detail?.kind === 'chat') return chatFields(detail);
  if (detail?.kind === 'event') return eventFields(detail);
  return null;
}

/**
 * The detail with `fields` in place of its synced fields: every synced field it should have, as
 * `syncedFieldsOf` gives them (a field missing from `fields`, or null, is a label or comment gone).
 */
export function withSyncedFields<D extends ItemDetail>(detail: D, fields: SyncedFields): D {
  if (detail.kind === 'linear-issue') return withLinearIssueFields(detail, fields) as D;
  if (detail.kind === 'chat') return withChatFields(detail, fields) as D;
  if (detail.kind === 'event') return withEventFields(detail, fields) as D;
  if (detail.kind === 'email') return withEmailFields(detail, fields) as D;
  return detail;
}

/** The Item status a detail implies, for kinds where it follows a synced field (a closed Linear state). */
export function statusFromDetail(detail: ItemDetail | null, otherwise: ItemStatus): ItemStatus {
  if (detail?.kind === 'email') return emailStatus(detail);
  if (detail?.kind !== 'linear-issue') return otherwise;
  return detail.state.type === 'completed' || detail.state.type === 'canceled' ? 'done' : 'open';
}
