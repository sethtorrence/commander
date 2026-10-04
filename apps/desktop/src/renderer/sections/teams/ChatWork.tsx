import type { ChatReplySuggestion, ChatTodoSuggestion } from '@commander/domain';
import { AresText } from '@commander/ui';

/*
  Ares's suggestions in the Chat view (#110), styled as suggestions (dashed, after the prototype's
  margin cards): a suggested Todo beside the message it came from, with Add and Dismiss, and a
  suggested reply above the reply box with the full draft and Send, Edit and Dismiss. What Ares wrote
  is shown through AresText, linking only what the Chat's messages hold. A suggested reply is only
  ever sent when the User presses Send.
*/

const small =
  'flex h-6 cursor-pointer items-center border border-line bg-sheet px-2 font-mono text-label leading-none font-semibold uppercase tracking-label whitespace-nowrap text-ink hover:border-ink';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "Fri 2 Oct", for a day as YYYY-MM-DD.
const dayName = (day: string) => {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const at = new Date(year, month - 1, date);
  return `${WEEKDAYS[at.getDay()]} ${date} ${MONTHS[month - 1]}`;
};

/** A Todo Ares suggests from a message: Add makes it, Dismiss drops it for good. */
export function TodoSuggestionCard({
  suggestion,
  sources,
  onAdd,
  onDismiss,
}: {
  suggestion: ChatTodoSuggestion;
  /** What the Chat's messages hold: what Ares's words may link to. */
  sources: readonly string[];
  onAdd: () => void;
  onDismiss: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a card holding two buttons, not a form's fieldset
    <div
      role="group"
      aria-label={`Suggested Todo: ${suggestion.title}`}
      data-testid="chat-todo-suggestion"
      className="mt-2 flex items-center gap-2 px-2.5 py-1.5 text-note outline-1 -outline-offset-1 outline-dashed outline-muted"
    >
      <span className="min-w-0 flex-1">
        <b className="font-mono text-label font-semibold uppercase tracking-label text-muted">Todo · Ares</b>{' '}
        <span className="text-ink">
          <AresText inline text={suggestion.title} sources={sources} />
        </span>
        {suggestion.dueOn && <span className="text-muted"> · due {dayName(suggestion.dueOn)}</span>}
      </span>
      <button type="button" className={small} onClick={onAdd}>
        Add
      </button>
      <button type="button" className={small} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

/**
 * Ares's suggested reply for a Chat waiting on the User, above the reply box: why, the full draft,
 * and Send (sends it as the User's reply), Edit (moves it into the reply box) and Dismiss.
 */
export function ReplySuggestionCard({
  suggestion,
  sources,
  onSend,
  onEdit,
  onDismiss,
}: {
  suggestion: ChatReplySuggestion;
  sources: readonly string[];
  onSend: () => void;
  onEdit: () => void;
  onDismiss: () => void;
}) {
  return (
    <section
      aria-label="Suggested reply"
      data-testid="chat-reply-suggestion"
      className="mt-4 px-3 py-2.5 outline-1 -outline-offset-1 outline-dashed outline-muted"
    >
      <p className="m-0 font-mono text-label leading-none font-semibold uppercase tracking-label text-muted">
        Suggested reply · Ares
      </p>
      <p className="m-0 mt-1.5 text-note text-muted" data-testid="chat-reply-reason">
        <AresText inline text={suggestion.reason} sources={sources} />
      </p>
      <div
        className="mt-2 text-[14px] leading-[1.5] whitespace-pre-wrap text-ink [overflow-wrap:anywhere]"
        data-testid="chat-reply-draft"
      >
        <AresText text={suggestion.reply.text} sources={sources} />
      </div>
      <div className="mt-2.5 flex items-center justify-end gap-2">
        <span className="mr-auto font-mono text-label uppercase tracking-label text-faint">
          Sent only when you press Send
        </span>
        <button type="button" className={small} onClick={onDismiss}>
          Dismiss
        </button>
        <button type="button" className={small} onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          onClick={onSend}
          className="cursor-pointer border border-ink bg-ink px-3 py-1 font-mono text-label-lg font-semibold uppercase tracking-label text-sheet"
        >
          Send
        </button>
      </div>
    </section>
  );
}
