import {
  ANSWER_NAMES,
  answerFields,
  carriesInvitation,
  type EmailDetail,
  type EmailInvitationCard,
  type EventDetail,
  emailWebUrl,
  type InvitationAnswer,
  type Item,
  type OutgoingChange,
  seriesAnswerOf,
} from '@commander/domain';
import { Button, toast } from '@commander/ui';
import { useCallback, useEffect, useState } from 'react';
import type { ItemChanges } from '../../item-store/changes';
import { clock } from '../calendar/agenda';
import { AnswerButtons, AnswerSync } from '../calendar/InvitationAnswer';
import { sourceName } from '../calendar/invitations';
import { whenLabel } from '../calendar/meetings';
import { localTimeZone } from '../calendar/ScheduleCard';
import { issueSync } from '../linear/editing';
import type { EmailClient } from './email';

/*
  The Invitation card (#144), above an invitation email's messages: its event's title, its time in the
  User's zone, a clash mark when it overlaps busy time in another Account, and Accept, Maybe and
  Decline (for an instance of a series, for all of it too), which answer the event exactly as from
  Calendar (#129): its synced field `response`, written back by Google Calendar or Outlook, with where
  that stands and Undo. While the event isn't synced yet the Core refreshes the Account's calendar
  first ("Looking in your calendar…"); an invitation for a calendar Commander doesn't sync (or one it
  still can't find) says so and offers Open in Gmail / Outlook.
*/

type Card = EmailInvitationCard | 'loading' | 'failed';

const emailOf = (item: Item | null): EmailDetail | null =>
  item?.detail?.kind === 'email' ? item.detail : null;

// "Thu 8 Oct 15:00–16:00", or "Thu 8 Oct, all day", in the User's zone.
function timeText(start: number, end: number | null, allDay: boolean, zone: string): string {
  const day = whenLabel(start, zone);
  if (allDay) return `${day.replace(/ \d{2}:\d{2}$/, '')}, all day`;
  return end !== null ? `${day}–${clock(end, zone)}` : day;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function InvitationCard({
  email,
  client,
  changes,
  address,
  personal = false,
}: {
  /** The invitation email (the thread's message carrying it). */
  email: Item;
  client: EmailClient;
  changes: ItemChanges;
  /** The Account's address, for Open in Gmail / Outlook. */
  address: string | null;
  /** A personal Outlook.com Account (Outlook on the web at outlook.live.com). */
  personal?: boolean;
}) {
  const [card, setCard] = useState<Card>('loading');
  const [outgoing, setOutgoing] = useState<OutgoingChange[]>([]);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const eventId = typeof card === 'object' && card.state === 'event' ? card.event.id : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload
  useEffect(() => {
    let current = true;
    client.invitation(email.id).then(
      (found) => current && setCard(found),
      () => current && setCard('failed'),
    );
    return () => {
      current = false;
    };
  }, [client, email.id, version]);

  // The event changing (an answer reaching the calendar, a sync): read again.
  useEffect(
    () =>
      changes((itemIds) => {
        if (itemIds.includes(email.id) || (eventId && itemIds.includes(eventId))) reload();
      }),
    [changes, email.id, eventId, reload],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload
  useEffect(() => {
    if (!eventId) return;
    let current = true;
    client.outgoing([eventId]).then(
      (found) => current && setOutgoing(found),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [client, eventId, version]);

  const detail = emailOf(email);
  if (!detail || !carriesInvitation(detail) || card === 'failed') return null;
  if (typeof card === 'object' && card.state === 'none') return null;
  const zone = localTimeZone();
  const where = email.source === 'outlook' ? 'Outlook' : 'Gmail';

  const answer = async (
    event: Item & { detail: EventDetail },
    response: InvitationAnswer,
    series: boolean,
  ) => {
    try {
      const entry = await client.answerInvitation(event.id, answerFields(event.detail, response, series));
      toast(`${ANSWER_NAMES[response]}: “${event.title}”`, {
        action: { label: 'Undo', onClick: () => void client.undo([entry.id]).then(reload) },
      });
    } catch (error) {
      toast(message(error));
    }
    reload();
  };

  return (
    <section
      aria-label="Invitation"
      data-testid="invitation-card"
      data-state={typeof card === 'object' ? card.state : card}
      className="mt-4 border border-line bg-sheet px-3.5 py-3"
    >
      <span className="font-mono text-label leading-none font-semibold uppercase tracking-caps text-muted">
        Invitation
      </span>
      {card === 'loading' ? (
        <p className="m-0 mt-2 text-note text-faint">Looking in your calendar…</p>
      ) : card.state === 'event' ? (
        <>
          <p className="m-0 mt-1.5 text-row font-semibold text-ink" data-testid="invitation-title">
            {card.event.title}
          </p>
          <p className="m-0 text-note text-muted" data-testid="invitation-when">
            {timeText(
              card.event.detail?.kind === 'event' ? card.event.detail.start.at : 0,
              card.event.detail?.kind === 'event' ? card.event.detail.end.at : null,
              card.event.detail?.kind === 'event' && card.event.detail.allDay,
              zone,
            )}
          </p>
          {card.clashes.length > 0 && (
            <p className="m-0 mt-1 text-note font-semibold text-signal-ink" data-testid="invitation-clash">
              Clashes with {card.clashes.map((each) => `“${each.title}”`).join(', ')} in another Account
            </p>
          )}
          {card.event.detail?.kind === 'event' && (
            <EventAnswers
              event={card.event as Item & { detail: EventDetail }}
              onAnswer={(response, series) =>
                void answer(card.event as Item & { detail: EventDetail }, response, series)
              }
            />
          )}
          <AnswerSync
            sync={issueSync(outgoing)}
            note={null}
            where={sourceName(card.event.source)}
            onRetry={() => void client.retry(card.event.id).then(reload, (error) => toast(message(error)))}
          />
        </>
      ) : (
        <>
          {card.title && <p className="m-0 mt-1.5 text-row font-semibold text-ink">{card.title}</p>}
          {card.start !== null && (
            <p className="m-0 text-note text-muted">{timeText(card.start, card.end, card.allDay, zone)}</p>
          )}
          <p className="m-0 mt-1.5 text-note text-text" data-testid="invitation-unsynced">
            {card.why === 'no-calendar'
              ? 'This invitation is for a calendar Commander doesn’t sync.'
              : 'Commander couldn’t find this event in your calendar, even after syncing it.'}
          </p>
          {emailWebUrl(email, { address, personal }) && (
            <Button
              size="sm"
              className="mt-2"
              onClick={() =>
                window.open(
                  emailWebUrl(email, { address, personal }) as string,
                  '_blank',
                  'noopener,noreferrer',
                )
              }
            >
              Open in {where} <span aria-hidden="true">↗</span>
            </Button>
          )}
        </>
      )}
    </section>
  );
}

// Accept, Maybe and Decline, the current answer pressed; for an instance of a series, for all of it too.
function EventAnswers({
  event,
  onAnswer,
}: {
  event: Item & { detail: EventDetail };
  onAnswer: (answer: InvitationAnswer, series: boolean) => void;
}) {
  const { detail } = event;
  return (
    <div className="mt-2.5 flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <span className="font-mono text-label-lg font-medium uppercase tracking-tag text-muted">
          {detail.seriesId ? 'This event' : 'Your answer'}
        </span>
        <AnswerButtons
          size="sm"
          current={detail.myResponse}
          label="Answer this invitation"
          onAnswer={(answer) => onAnswer(answer, false)}
        />
      </div>
      {detail.seriesId && (
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <span className="font-mono text-label-lg font-medium uppercase tracking-tag text-muted">
            All events in the series
          </span>
          <AnswerButtons
            size="sm"
            current={seriesAnswerOf(detail)}
            label="Answer all events in the series"
            onAnswer={(answer) => onAnswer(answer, true)}
          />
        </div>
      )}
    </div>
  );
}

/** The thread's message carrying an invitation to answer, the latest such, or null. */
export function invitationIn(messages: readonly { item: Item }[]): Item | null {
  return (
    [...messages].reverse().find(({ item }) => {
      const detail = emailOf(item);
      return !!detail && item.deletedAt === null && carriesInvitation(detail);
    })?.item ?? null
  );
}
