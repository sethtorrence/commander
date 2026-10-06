import { CANCEL_SEND_FIELD, DELETE_FIELD, DRAFT_FIELD, SEND_FIELD } from '@commander/domain';
import type { FieldChange } from '../source';

/**
 * Whether a write is a message written in Commander's (#138): its `draft`, `send` or `delete` (a draft
 * discarded), or (send later held by Microsoft, #139) `cancel-send`, rather than organising mail. Email
 * Sources never queue `delete` for anything else.
 */
export const isComposeWrite = (changes: readonly FieldChange[]) =>
  changes.some(
    (change) =>
      change.field === DRAFT_FIELD || change.field === SEND_FIELD || change.field === CANCEL_SEND_FIELD,
  ) ||
  (changes.length > 0 && changes.every((change) => change.field === DELETE_FIELD));
