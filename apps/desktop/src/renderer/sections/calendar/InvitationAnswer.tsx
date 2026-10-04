import {
  ANSWER_NAMES,
  canAnswer,
  type EventResponse,
  INVITATION_ANSWERS,
  type InvitationAnswer,
  seriesAnswerOf,
} from '@commander/domain';
import { AresText, Button, ButtonGroup, cn, Kbd } from '@commander/ui';
import type { IssueSync } from '../linear/editing';
import type { CalendarEvent } from './agenda';
import { type SuggestedReply, sourceName } from './invitations';

/*
  Answering an invitation (#129): Accept, Maybe and Decline with the current answer pressed, Ares's
  suggested reply with Send and Dismiss (drawn as a suggestion: a dashed box), and where the answer
  stands (on its way, Couldn't sync with Retry, or the note when an answer given in Google Calendar or
  Outlook won). Shown in the detail pane, and compactly on the Agenda row.
*/

/** The keys for each answer: letters the fixed scheme (#29) and the Calendar views leave free. */
export const ANSWER_KEYS: Record<InvitationAnswer, string> = { accepted: 'y', tentative: 'i', declined: 'n' };

function AnswerButtons({
  current,
  label,
  keys = false,
  size = 'default',
  onAnswer,
}: {
  current: EventResponse | null;
  label: string;
  keys?: boolean;
  size?: 'sm' | 'default';
  onAnswer: (answer: InvitationAnswer) => void;
}) {
  return (
    <ButtonGroup role="group" aria-label={label}>
      {INVITATION_ANSWERS.map((answer) => {
        const pressed = current === answer;
        return (
          <Button
            key={answer}
            size={size}
            variant={pressed ? 'primary' : 'default'}
            aria-pressed={pressed}
            onClick={(click) => {
              click.stopPropagation();
              onAnswer(answer);
            }}
          >
            {ANSWER_NAMES[answer]}
            {keys && <Kbd>{ANSWER_KEYS[answer].toUpperCase()}</Kbd>}
          </Button>
        );
      })}
    </ButtonGroup>
  );
}

/** Ares's suggested reply, with his reason (his words, as AresText), Send and Dismiss. */
export function SuggestedReplyCard({
  reply,
  compact = false,
  onSend,
  onDismiss,
}: {
  reply: SuggestedReply;
  compact?: boolean;
  onSend: () => void;
  onDismiss: () => void;
}) {
  const answer = ANSWER_NAMES[reply.answer as InvitationAnswer] ?? reply.answer;
  return (
    <div
      data-testid="suggested-reply"
      className={cn(
        'flex items-center gap-2.5 border border-dashed border-muted text-note',
        compact ? 'px-2 py-1' : 'mt-3 px-2.5 py-2',
      )}
    >
      <span className="min-w-0 flex-1">
        <b className="font-mono text-label-lg font-semibold uppercase tracking-label text-ink">
          Ares suggests: {answer}
        </b>
        <span className="text-muted"> · </span>
        <AresText inline text={reply.reason} sources={[reply.source]} className="text-text" />
      </span>
      <Button
        size="sm"
        variant="signal"
        onClick={(click) => {
          click.stopPropagation();
          onSend();
        }}
      >
        Send
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={(click) => {
          click.stopPropagation();
          onDismiss();
        }}
      >
        Dismiss
      </Button>
    </div>
  );
}

/** Where the answer stands, under the buttons. */
function AnswerSync({
  sync,
  note,
  where,
  onRetry,
}: {
  sync: IssueSync;
  note: string | null;
  where: string;
  onRetry: () => void;
}) {
  if (sync.kind === 'failed') {
    return (
      <div
        role="alert"
        data-testid="answer-sync"
        className="mt-2.5 flex items-center justify-between gap-2.5 border border-ink px-2.5 py-1.5 text-note"
      >
        <span>
          <b className="font-semibold text-ink">Couldn’t sync</b>
          {sync.error && <span className="text-muted"> · {sync.error}</span>}
        </span>
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  if (sync.kind === 'sending') {
    return (
      <p role="status" data-testid="answer-sync" className="m-0 mt-2.5 text-note text-muted">
        Saving to {where}…
      </p>
    );
  }
  if (note) {
    return (
      <p
        role="status"
        data-testid="answer-sync"
        className="m-0 mt-2.5 border border-line px-2.5 py-1.5 text-note text-text"
      >
        {note}
      </p>
    );
  }
  return null;
}

/** The detail pane's answer: this event (and, for a series, all of it), Ares's suggestion and the sync line. */
export function InvitationPanel({
  event,
  reply,
  sync,
  note,
  onAnswer,
  onSend,
  onDismiss,
  onRetry,
}: {
  event: CalendarEvent;
  reply: SuggestedReply | null;
  sync: IssueSync;
  /** An answer given in Google Calendar or Outlook that won over the User's, as its note. */
  note: string | null;
  onAnswer: (answer: InvitationAnswer, series: boolean) => void;
  onSend: (reply: SuggestedReply) => void;
  onDismiss: (reply: SuggestedReply) => void;
  onRetry: () => void;
}) {
  const { detail } = event;
  if (!canAnswer(detail)) return null;
  return (
    <section aria-label="Your answer" data-testid="invitation" className="mt-3.5 border-t border-line pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <span className="font-mono text-label-lg font-medium uppercase tracking-tag text-muted">
          {detail.seriesId ? 'This event' : 'Your answer'}
        </span>
        <AnswerButtons
          keys
          current={detail.myResponse}
          label="Answer this invitation"
          onAnswer={(answer) => onAnswer(answer, false)}
        />
      </div>
      {detail.seriesId && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2.5">
          <span className="font-mono text-label-lg font-medium uppercase tracking-tag text-muted">
            All events in the series
          </span>
          <AnswerButtons
            current={seriesAnswerOf(detail)}
            label="Answer all events in the series"
            onAnswer={(answer) => onAnswer(answer, true)}
          />
        </div>
      )}
      {reply && (
        <SuggestedReplyCard reply={reply} onSend={() => onSend(reply)} onDismiss={() => onDismiss(reply)} />
      )}
      <AnswerSync sync={sync} note={note} where={sourceName(event.source)} onRetry={onRetry} />
    </section>
  );
}

/** The Agenda row's answer, at the end of its line: small buttons, and Couldn't sync. */
export function RowAnswer({
  event,
  sync,
  onAnswer,
}: {
  event: CalendarEvent;
  sync: IssueSync;
  onAnswer: (answer: InvitationAnswer) => void;
}) {
  if (!canAnswer(event.detail)) return null;
  return (
    <span data-testid="row-answer" className="flex items-center gap-2">
      {sync.kind === 'failed' && (
        <span className="font-mono text-label font-semibold uppercase tracking-label text-ink">
          Couldn’t sync
        </span>
      )}
      <AnswerButtons
        size="sm"
        current={event.detail.myResponse}
        label={`Answer ${event.title}`}
        onAnswer={onAnswer}
      />
    </span>
  );
}
