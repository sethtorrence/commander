import type { ItemDetail, ItemStatus } from './items';
import type { LinearIssueDetail } from './linear';

// Two-way sync's view of an Item's detail: the fields that write back to its Source, each keyed so
// it changes on its own. The User's edits, the outgoing queue, undo and the conflict rule (the newer
// change wins, per field) all work field by field through this view, so a change to one field never
// carries a stale copy of another.
//
// Linear issues: `state`, `assignee`, `priority`, `dueDate`, `estimate`, `cycle`, `linearProject`,
// one `label:<id>` per label (the label, or null once removed) and one `comment:<id>` per comment
// (the comment, or null once deleted). The description, title and team are not synced fields: they
// are read-only in Commander.

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

/** Whether `field` names one of a detail kind's synced fields. */
export function isSyncedField(kind: ItemDetail['kind'], field: string): boolean {
  if (kind !== 'linear-issue') return false;
  return (
    isScalar(field) ||
    (field.startsWith(LABEL_FIELD) && field.length > LABEL_FIELD.length) ||
    (field.startsWith(COMMENT_FIELD) && field.length > COMMENT_FIELD.length)
  );
}

/** The detail's synced fields, or null for a kind that doesn't write back to a Source. */
export function syncedFieldsOf(detail: ItemDetail | null): SyncedFields | null {
  return detail?.kind === 'linear-issue' ? linearIssueFields(detail) : null;
}

/**
 * The detail with `fields` in place of its synced fields: every synced field it should have, as
 * `syncedFieldsOf` gives them (a field missing from `fields`, or null, is a label or comment gone).
 */
export function withSyncedFields<D extends ItemDetail>(detail: D, fields: SyncedFields): D {
  return detail.kind === 'linear-issue' ? (withLinearIssueFields(detail, fields) as D) : detail;
}

/** The Item status a detail implies, for kinds where it follows a synced field (a closed Linear state). */
export function statusFromDetail(detail: ItemDetail | null, otherwise: ItemStatus): ItemStatus {
  if (detail?.kind !== 'linear-issue') return otherwise;
  return detail.state.type === 'completed' || detail.state.type === 'canceled' ? 'done' : 'open';
}
