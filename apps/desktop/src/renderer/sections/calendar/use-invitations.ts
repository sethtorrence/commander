import {
  type ActivityEntry,
  answerFields,
  canAnswer,
  type EventResponse,
  type OutgoingChange,
} from '@commander/domain';
import { toast } from '@commander/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type IssueSync, issueSync } from '../linear/editing';
import type { CalendarEvent } from './agenda';
import { type CalendarAccount, calendarSyncOf } from './calendar-events';
import type { InvitationsClient, SuggestedReply } from './invitations';
import { suggestedReplyOf } from './invitations';

/*
  The Calendar Section's side of answering invitations (#129): Ares's suggested replies by invitation,
  each event's answers still on their way to Google Calendar or Outlook (or that couldn't sync), and
  answering, sending or dismissing a suggestion and retrying. Answers go through the Section's
  `apply`, so they show at once and Ctrl+Z undoes them (which sends the previous answer).
*/

const report = (error: unknown) => toast(error instanceof Error ? error.message : String(error));

// What changes when an Account syncs or sends: its calendar Source's last sync and outgoing counts.
const signatureOf = (accounts: readonly CalendarAccount[]) =>
  accounts
    .map((account) => {
      const sync = calendarSyncOf(account);
      return `${account.id}:${sync?.lastSyncedAt ?? ''}:${sync?.outgoing?.pending ?? 0}/${sync?.outgoing?.failed ?? 0}`;
    })
    .join('|');

export function useInvitations({
  client,
  accounts,
  events,
  apply,
}: {
  client: InvitationsClient | null;
  accounts: readonly CalendarAccount[];
  /** The events shown: read again whenever they are. */
  events: readonly unknown[];
  apply: (change: () => Promise<ActivityEntry>) => Promise<ActivityEntry | null>;
}) {
  const [replies, setReplies] = useState<SuggestedReply[]>([]);
  const [outgoing, setOutgoing] = useState<OutgoingChange[]>([]);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const signature = signatureOf(accounts);

  useEffect(() => client?.onAresChange(reload), [client, reload]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a sync, the events shown or `version` ask for a reload
  useEffect(() => {
    if (!client) return;
    let current = true;
    client.suggestions().then((rows) => {
      if (current) setReplies(rows.map(suggestedReplyOf).filter((row): row is SuggestedReply => !!row));
    }, report);
    client.outgoing().then((next) => current && setOutgoing(next), report);
    return () => {
      current = false;
    };
  }, [client, signature, events, version]);

  const suggestions = useMemo(() => new Map(replies.map((reply) => [reply.itemId, reply])), [replies]);
  const byItem = useMemo(() => {
    const map = new Map<string, OutgoingChange[]>();
    for (const change of outgoing) map.set(change.itemId, [...(map.get(change.itemId) ?? []), change]);
    return map;
  }, [outgoing]);

  const syncOf = useCallback((itemId: string): IssueSync => issueSync(byItem.get(itemId) ?? []), [byItem]);

  const answer = useCallback(
    async (event: CalendarEvent, response: EventResponse, series = false) => {
      if (!client || !canAnswer(event.detail)) return;
      await apply(() => client.answer(event.id, answerFields(event.detail, response, series)));
      reload();
    },
    [client, apply, reload],
  );

  const send = useCallback(
    async (reply: SuggestedReply) => {
      if (!client) return;
      await apply(async () => {
        const entry = await client.send(reply.id);
        if (!entry) throw new Error('Ares’s suggestion is no longer waiting');
        return entry;
      });
      reload();
    },
    [client, apply, reload],
  );

  const dismiss = useCallback(
    async (reply: SuggestedReply) => {
      try {
        await client?.dismiss(reply.id);
      } catch (error) {
        report(error);
      }
      reload();
    },
    [client, reload],
  );

  const retry = useCallback(
    async (itemId: string) => {
      try {
        await client?.retry(itemId);
      } catch (error) {
        report(error);
      }
      reload();
    },
    [client, reload],
  );

  return { enabled: !!client, suggestions, syncOf, answer, send, dismiss, retry };
}

export type InvitationsState = ReturnType<typeof useInvitations>;
