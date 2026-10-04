import {
  type ActivityEntry,
  type AresActivity,
  calendarSources,
  type EventResponse,
  eventResponses,
  type OutgoingChange,
  REPLY_TO_INVITATIONS,
  type Source,
} from '@commander/domain';
import type { ItemStoreClient } from '../../item-store/client';
import type { AutonomyClient } from '../ares/activity';

/*
  Answering invitations from the Calendar Section (#129): what it reads and asks of the app, through
  the window's bridge. An answer is an Item store change to the synced field `response` (and
  `seriesResponse` for the whole series), which the Core queues for Google Calendar or Outlook; Ares's
  suggested replies are the gate's pending "Reply to invitations" suggestions, sent (accepted) or
  dismissed through it.
*/

export interface InvitationsClient {
  /** Answers an invitation (`edit-fields` on its answer fields), as the User. */
  answer(itemId: string, fields: Record<string, EventResponse>): Promise<ActivityEntry>;
  /** The calendar changes waiting to reach Google Calendar or Outlook, or that couldn't sync. */
  outgoing(): Promise<OutgoingChange[]>;
  /** Tries an event's changes that couldn't sync again. */
  retry(itemId: string): Promise<void>;
  /** Ares's suggested replies still waiting for the User. */
  suggestions(): Promise<AresActivity[]>;
  /** Sends a suggested reply (accepts the suggestion): returns the answer's activity entry, for Undo. */
  send(proposalId: number): Promise<ActivityEntry | null>;
  dismiss(proposalId: number): Promise<void>;
  /** Called whenever Ares did or suggested something. Returns the unsubscribe. */
  onAresChange(listener: () => void): () => void;
}

type Bridge = { itemStore: ItemStoreClient; autonomy: AutonomyClient } & Partial<
  Pick<Window['commander'], 'onCoreMessage'>
>;

const isCalendarSource = (source: Source) => (calendarSources as readonly Source[]).includes(source);

export function invitationsIn(bridge: Bridge): InvitationsClient {
  const { itemStore, autonomy } = bridge;
  return {
    answer: (itemId, fields) => itemStore({ op: 'record', action: { type: 'edit-fields', itemId, fields } }),
    async outgoing() {
      const changes = await itemStore({ op: 'outgoing', query: {} });
      return changes.filter((change) => isCalendarSource(change.source));
    },
    async retry(itemId) {
      await itemStore({ op: 'retry-outgoing', itemId });
    },
    suggestions: () =>
      autonomy({
        op: 'activity',
        query: { action: REPLY_TO_INVITATIONS, statuses: ['pending'], limit: 500 },
      }),
    async send(proposalId) {
      const record = await autonomy({ op: 'accept', proposalId });
      const [entryId] = record.entryIds;
      if (!entryId) return null;
      const entries = await itemStore({ op: 'activity', query: { itemId: record.itemId, limit: 20 } });
      return entries.find((entry) => entry.id === entryId) ?? null;
    },
    async dismiss(proposalId) {
      await autonomy({ op: 'dismiss', proposalId });
    },
    onAresChange(listener) {
      return (
        bridge.onCoreMessage?.((message) => {
          if (message.type === 'ares-activity') listener();
        }) ?? (() => {})
      );
    },
  };
}

/** A suggested reply, as the invitation shows it. */
export interface SuggestedReply {
  /** The suggestion (the gate's proposal) id. */
  id: number;
  itemId: string;
  answer: EventResponse;
  reason: string;
  /** What Ares's words may link to (AresText): the invitation's title. */
  source: string;
}

/** A pending "Reply to invitations" suggestion as its invitation shows it, or null for anything else. */
export function suggestedReplyOf(row: AresActivity): SuggestedReply | null {
  if (row.status !== 'pending' || row.action !== REPLY_TO_INVITATIONS) return null;
  const step = row.itemActions.find((action) => action.type === 'edit-fields');
  const answer = step?.type === 'edit-fields' ? step.fields.response : undefined;
  if (!(eventResponses as readonly unknown[]).includes(answer)) return null;
  return {
    id: row.id,
    itemId: row.itemId,
    answer: answer as EventResponse,
    reason: row.reason,
    source: row.item?.title ?? '',
  };
}

/** Where the Section names an event's Source: "Google Calendar", "Outlook". */
export const sourceName = (source: Source | null) =>
  source === 'outlook-calendar' ? 'Outlook' : 'Google Calendar';
