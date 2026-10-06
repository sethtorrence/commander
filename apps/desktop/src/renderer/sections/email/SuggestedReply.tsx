import type { SuggestedReply } from '@commander/domain';
import { AresText, Led } from '@commander/ui';
import { useState } from 'react';

/*
  Ares's suggested reply at the end of a thread (#143), styled as a suggestion (dashed, like his other
  cards). Offered (at Ask, or before his job has got to it): Draft a reply, with what to say if the User
  likes, and Dismiss. Ready: his draft through AresText (a link clickable only when the thread holds
  it), the links he added that are in neither the thread nor the User's sent mail, a note when he isn't
  sure, and Open in composer (an ordinary draft, the User's to edit and send), Draft again and Dismiss.
  Nothing here sends anything, and nothing of it reaches Gmail or Outlook until it is opened.
*/

const small =
  'flex h-6 cursor-pointer items-center border border-line bg-sheet px-2 font-mono text-label leading-none font-semibold uppercase tracking-label whitespace-nowrap text-ink hover:border-ink disabled:cursor-default disabled:text-faint';
const primary =
  'cursor-pointer border border-ink bg-ink px-3 py-1 font-mono text-label-lg font-semibold uppercase tracking-label text-sheet';
const heading = 'm-0 font-mono text-label leading-none font-semibold uppercase tracking-label text-muted';

export function SuggestedReplyCard({
  suggestion,
  drafting,
  sources,
  onDraft,
  onOpen,
  onDismiss,
}: {
  suggestion: SuggestedReply | null;
  /** Ares is drafting one now (asked for in this window). */
  drafting: boolean;
  /** What the thread's messages hold: what Ares's words may link to. */
  sources: readonly string[];
  /** Draft a reply (or again), with what the User wants said, if anything. */
  onDraft: (instruction?: string) => void;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const [instruction, setInstruction] = useState('');
  if (drafting) {
    return (
      <section
        aria-label="Suggested reply"
        aria-busy="true"
        data-testid="suggested-reply"
        data-state="drafting"
        className="mt-6 flex items-center gap-2 px-3 py-2.5 outline-1 -outline-offset-1 outline-dashed outline-muted"
      >
        <Led size="sm" />
        <p className={heading}>Ares is drafting a reply…</p>
      </section>
    );
  }
  if (!suggestion) return null;

  if (suggestion.state === 'offered') {
    return (
      <section
        aria-label="Suggested reply"
        data-testid="suggested-reply"
        data-state="offered"
        className="mt-6 px-3 py-2.5 outline-1 -outline-offset-1 outline-dashed outline-muted"
      >
        <p className={heading}>Suggested reply · Ares</p>
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onDraft(instruction.trim() || undefined);
          }}
        >
          <input
            aria-label="What the reply should say (optional)"
            placeholder="Ares can draft a reply in your style. What should it say? (optional)"
            value={instruction}
            maxLength={1000}
            onChange={(event) => setInstruction(event.target.value)}
            className="h-7 min-w-0 flex-1 border border-line bg-sheet px-2 text-note text-ink outline-none focus:border-ink"
          />
          <button type="button" className={small} onClick={onDismiss}>
            Dismiss
          </button>
          <button type="submit" className={primary}>
            Draft a reply
          </button>
        </form>
      </section>
    );
  }

  return (
    <section
      aria-label="Suggested reply"
      data-testid="suggested-reply"
      data-state="ready"
      className="mt-6 px-3 py-2.5 outline-1 -outline-offset-1 outline-dashed outline-muted"
    >
      <p className={heading}>Suggested reply · Ares</p>
      {!suggestion.sure && (
        <p className="m-0 mt-1.5 text-note text-muted" data-testid="suggested-reply-unsure">
          Ares isn’t sure about this one: read it closely before you send it.
        </p>
      )}
      <div
        className="mt-2 text-[14px] leading-[1.5] whitespace-pre-wrap text-ink [overflow-wrap:anywhere]"
        data-testid="suggested-reply-body"
      >
        <AresText text={suggestion.body} sources={sources} />
      </div>
      {suggestion.addedLinks.length > 0 && (
        <div
          className="mt-2 border-t border-line2 pt-2 text-note text-muted"
          data-testid="suggested-reply-links"
        >
          <p className="m-0">
            Ares added {suggestion.addedLinks.length === 1 ? 'a link' : 'links'} that{' '}
            {suggestion.addedLinks.length === 1 ? 'is' : 'are'} in neither the thread nor your sent mail.{' '}
            {suggestion.addedLinks.length === 1 ? 'It isn’t' : 'They aren’t'} sent unless you keep{' '}
            {suggestion.addedLinks.length === 1 ? 'it' : 'them'} in the composer:
          </p>
          <ul className="m-0 mt-1 list-none p-0">
            {suggestion.addedLinks.map((link) => (
              <li key={link} className="font-mono text-label break-all text-ink">
                {link}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-2.5 flex items-center justify-end gap-2">
        <span className="mr-auto font-mono text-label uppercase tracking-label text-faint">
          Sent only when you press Send
        </span>
        <button type="button" className={small} onClick={onDismiss}>
          Dismiss
        </button>
        <button type="button" className={small} onClick={() => onDraft()}>
          Draft again
        </button>
        <button type="button" className={primary} onClick={onOpen}>
          Open in composer
        </button>
      </div>
    </section>
  );
}
