import {
  type AresActivity,
  bookingLinkText,
  type EmailDetail,
  emailCause,
  type Item,
  isOutsideGuest,
  type SchedulingAccount,
} from '@commander/domain';
import { AresText, Button, toast } from '@commander/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ItemChanges } from '../../item-store/changes';
import type { ItemStoreClient } from '../../item-store/client';
import type { AutonomyClient } from '../ares/activity';
import { MeetingCard } from '../calendar/MeetingCard';
import {
  changesFrom,
  type MeetingDraft,
  type MeetingProposal,
  meetingProposalOf,
} from '../calendar/meetings';
import { localTimeZone } from '../calendar/ScheduleCard';
import { useScheduling } from '../calendar/use-scheduling';

/*
  Ares on an email thread (#144): what he suggests from its messages, waiting for the User.

  - Suggested Todos ("Suggest Todos" at Ask): the Todo he would add from what the email asks ("Send Dana
    the Q3 numbers", due Friday), with Add (accepting it through the gate: a Todo with a made-from Link
    to the email and its Project) and Dismiss.
  - Proposed events: the meeting card from Blocks (#132), the same resolving, free-time check, Create,
    Other times, Edit in Google Calendar or Outlook, and Dismiss, showing what caused it ("Suggested
    because of Dana's email, 10:42"): an event from an email is always a chained suggestion. When the
    sender's domain matches none of the User's Accounts and a booking link is saved, Reply with your
    booking link opens a reply holding "Book a time here: <link>" for the User to edit and send.
*/

const SUGGEST_TODOS = 'suggest-todos';

/** A suggested Todo on one of the thread's messages. */
export type EmailTodoSuggestion = {
  id: number;
  emailId: string;
  title: string;
  dueOn: string | null;
  reason: string;
};

/** A pending "Suggest Todos" suggestion on an email, as its card shows it; null for anything else. */
export function emailTodoSuggestionOf(row: AresActivity): EmailTodoSuggestion | null {
  if (row.status !== 'pending' || row.action !== SUGGEST_TODOS || row.item?.kind !== 'email') return null;
  const step = row.itemActions.find((action) => action.type === 'create' && action.item.kind === 'todo');
  if (step?.type !== 'create') return null;
  const detail = step.item.detail;
  return {
    id: row.id,
    emailId: row.itemId,
    title: step.item.title,
    dueOn: detail?.kind === 'todo' ? detail.dueOn : null,
    reason: row.reason,
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Ares's waiting suggestions on a thread's messages: Todos and events, read again as he acts. */
function useThreadSuggestions(
  autonomy: AutonomyClient | undefined,
  itemIds: readonly string[],
  changes: ItemChanges,
  onAresActivity?: (listener: () => void) => () => void,
) {
  const [rows, setRows] = useState<AresActivity[]>([]);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => onAresActivity?.(reload), [onAresActivity, reload]);
  useEffect(() => changes(reload), [changes, reload]);
  const key = itemIds.join(',');

  // biome-ignore lint/correctness/useExhaustiveDependencies: the thread (`key`) and `version` ask for a reload
  useEffect(() => {
    if (!autonomy || !itemIds.length) return setRows([]);
    let current = true;
    Promise.all(
      (['email', 'calendar'] as const).map((section) =>
        autonomy({ op: 'activity', query: { section, statuses: ['pending'], limit: 500 } }),
      ),
    ).then(
      (found) => current && setRows(found.flat()),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [autonomy, key, version]);

  return useMemo(() => {
    const mine = new Set(itemIds);
    const ours = rows.filter((row) => mine.has(row.itemId)).sort((a, b) => a.id - b.id);
    return {
      todos: ours.map(emailTodoSuggestionOf).filter((row): row is EmailTodoSuggestion => row !== null),
      events: ours.map(meetingProposalOf).filter((row): row is MeetingProposal => row !== null),
      reload,
    };
  }, [rows, itemIds, reload]);
}

const emailOf = (item: Item | undefined): EmailDetail | null =>
  item?.detail?.kind === 'email' ? item.detail : null;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "Fri 9 Oct", for a due day.
function dueLabel(day: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return `${WEEKDAYS[new Date(year, month - 1, date).getDay()]} ${date} ${MONTHS[month - 1]}`;
}

export function AresOnThread({
  messages,
  autonomy,
  itemStore,
  changes,
  onAresActivity,
  accountAddresses,
  onReplyWithBookingLink,
}: {
  /** The thread's messages, oldest first, with their text (what Ares's words may link to). */
  messages: readonly { item: Item; body: { text: string } | null }[];
  autonomy?: AutonomyClient;
  /** The Item store (the window's bridge): the meeting card's free-time check and Other times. */
  itemStore?: ItemStoreClient;
  changes: ItemChanges;
  onAresActivity?: (listener: () => void) => () => void;
  /** The User's Accounts' addresses: whose domain is the User's own organisations. */
  accountAddresses: readonly string[];
  /** Opens a reply to the email holding the booking link's text. */
  onReplyWithBookingLink: (emailId: string, text: string, link: string) => void;
}) {
  const itemIds = useMemo(() => messages.map(({ item }) => item.id), [messages]);
  const suggestions = useThreadSuggestions(autonomy, itemIds, changes, onAresActivity);
  const sources = useMemo(() => messages.flatMap(({ body }) => (body ? [body.text] : [])), [messages]);
  if (!autonomy || (!suggestions.todos.length && !suggestions.events.length)) return null;

  const settle = async (run: () => Promise<unknown>, done?: string) => {
    try {
      await run();
      if (done) toast(done);
    } catch (error) {
      toast(message(error));
    }
    suggestions.reload();
  };

  return (
    <>
      {suggestions.todos.map((todo) => (
        <section
          key={todo.id}
          aria-label="Suggested Todo"
          data-testid="email-todo-suggestion"
          className="mt-4 flex items-center gap-3 border border-dashed border-ink px-3 py-2 text-note text-ink"
        >
          <span className="min-w-0 flex-1">
            <b className="font-mono text-label-lg font-semibold uppercase tracking-label">
              Ares suggests a Todo
            </b>
            <span className="text-muted"> · </span>
            <span className="font-semibold">{todo.title}</span>
            {todo.dueOn && <span className="text-muted"> · due {dueLabel(todo.dueOn)}</span>}
            <span className="block text-muted">
              <AresText inline text={todo.reason} sources={sources} />
            </span>
          </span>
          <Button onClick={() => void settle(() => autonomy({ op: 'dismiss', proposalId: todo.id }))}>
            Dismiss
          </Button>
          <Button
            variant="primary"
            onClick={() =>
              void settle(
                () => autonomy({ op: 'accept', proposalId: todo.id }),
                `Added “${todo.title}” to Todos`,
              )
            }
          >
            Add
          </Button>
        </section>
      ))}
      {itemStore &&
        suggestions.events.map((proposal) => (
          <EventProposal
            key={proposal.id}
            proposal={proposal}
            email={messages.find(({ item }) => item.id === proposal.blockId)?.item}
            itemStore={itemStore}
            sources={sources}
            accountAddresses={accountAddresses}
            onCreate={(draft) =>
              settle(
                () =>
                  autonomy({
                    op: 'accept',
                    proposalId: proposal.id,
                    changes: changesFrom(proposal.draft, draft),
                  }),
                draft.guests.length
                  ? `“${draft.title}” is in your calendar, and the invitations are on their way`
                  : `“${draft.title}” is in your calendar`,
              )
            }
            onDismiss={() => void settle(() => autonomy({ op: 'dismiss', proposalId: proposal.id }))}
            onReplyWithBookingLink={onReplyWithBookingLink}
          />
        ))}
    </>
  );
}

// One proposed event: the meeting card, its cause, and Reply with your booking link for an outsider.
function EventProposal({
  proposal,
  email,
  itemStore,
  sources,
  accountAddresses,
  onCreate,
  onDismiss,
  onReplyWithBookingLink,
}: {
  proposal: MeetingProposal;
  email: Item | undefined;
  itemStore: ItemStoreClient;
  sources: string[];
  accountAddresses: readonly string[];
  onCreate: (draft: MeetingDraft) => Promise<void>;
  onDismiss: () => void;
  onReplyWithBookingLink: (emailId: string, text: string, link: string) => void;
}) {
  const [draft, setDraft] = useState(proposal.draft);
  const scheduling = useScheduling(itemStore, true);
  const detail = emailOf(email);
  const sender = detail?.from?.address ?? null;
  const mine: SchedulingAccount[] = accountAddresses.map((address) => ({
    account: address,
    source: 'google-calendar',
    address,
    work: false,
  }));
  // Someone outside the User's organisations, with a booking link saved: offer it instead of a time.
  const offerLink = !!scheduling.bookingLink && !!sender && isOutsideGuest(sender, mine);
  return (
    <section
      aria-label="Proposed event"
      data-testid="email-event-proposal"
      className="mt-4 border border-dashed border-ink px-3 py-2.5"
    >
      <p className="m-0 mb-1.5 font-mono text-label-lg font-semibold uppercase tracking-label text-ink">
        Ares suggests an event
      </p>
      {detail && (
        <p className="m-0 mb-2 text-note text-muted" data-testid="email-event-cause">
          {emailCause(detail, Date.now())}
        </p>
      )}
      <MeetingCard
        draft={draft}
        onChange={setDraft}
        timeZone={localTimeZone()}
        accounts={scheduling.accounts}
        calendars={scheduling.calendars}
        // Offered below as a reply to the email, never copied from here.
        bookingLink={null}
        itemStore={itemStore}
        reason={{ text: proposal.reason, sources }}
        details={detail ? `From ${detail.subject}` : undefined}
        onCreate={() => void onCreate(draft)}
        onDismiss={onDismiss}
        variant="dialog"
      />
      {offerLink && email && (
        <Button
          size="sm"
          variant="ghost"
          className="mt-2"
          onClick={() =>
            onReplyWithBookingLink(
              email.id,
              bookingLinkText(scheduling.bookingLink as string),
              scheduling.bookingLink as string,
            )
          }
        >
          Reply with your booking link
        </Button>
      )}
    </section>
  );
}
