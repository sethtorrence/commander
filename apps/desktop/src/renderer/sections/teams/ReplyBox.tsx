import { MAX_REPLY_LENGTH } from '@commander/domain';
import { AresButton, Kbd } from '@commander/ui';

/*
  The reply box at the bottom of the Chat view (#106): plain text with line breaks, sent with
  Ctrl+Enter (the Section's shortcut, listed in `?`) or Send. What is typed is the User's own text,
  sent to Teams exactly as written (escaped, never markup). The draft lives with the Section, one
  per Chat, so moving between Chats keeps each one's. Draft, Ares's entry here, is the shared Ares
  button (#193).
*/

/** Whether keys pressed here are typed into a reply box. */
export const inReplyBox = (element: Element | null) => !!element?.closest('[data-reply-box]');

export function ReplyBox({
  to,
  draft,
  onDraft,
  onSend,
  onAskAres,
  drafting = false,
}: {
  /** Who the reply goes to: the Chat's name. */
  to: string;
  draft: string;
  onDraft: (text: string) => void;
  onSend: () => void;
  /** Draft (#110): Ares drafts a reply into the box. Absent, there is no Draft button. */
  onAskAres?: () => void;
  /** Whether Ares is drafting one now. */
  drafting?: boolean;
}) {
  const tooLong = draft.length > MAX_REPLY_LENGTH;
  return (
    <div data-reply-box className="mt-4 border border-line">
      <textarea
        aria-label="Reply"
        placeholder={`Reply to ${to}…`}
        value={draft}
        rows={3}
        onChange={(event) => onDraft(event.target.value)}
        className="block w-full resize-y border-0 bg-sheet px-3.5 py-2.5 font-sans text-[14px] text-ink caret-signal placeholder:text-faint focus-visible:outline-none"
      />
      <div className="flex items-center justify-end gap-2.5 border-t border-line2 px-2.5 py-1.5">
        {tooLong ? (
          <span role="status" className="font-mono text-label uppercase tracking-label text-ink">
            Too long for one Teams message
          </span>
        ) : (
          <span className="flex items-center gap-1.5 font-mono text-label uppercase tracking-label text-faint">
            <Kbd>Ctrl ↵</Kbd> sends to Teams
          </span>
        )}
        {onAskAres && (
          <AresButton
            variant="pane"
            label={drafting ? 'Drafting…' : 'Draft'}
            busy={drafting}
            disabled={drafting}
            title="Ares drafts a reply into the box"
            onClick={onAskAres}
            className="h-auto px-3 py-1 text-label-lg"
          />
        )}
        <button
          type="button"
          disabled={!draft.trim() || tooLong}
          onClick={onSend}
          className="cursor-pointer border border-ink bg-ink px-3 py-1 font-mono text-label-lg font-semibold uppercase tracking-label text-sheet disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}
