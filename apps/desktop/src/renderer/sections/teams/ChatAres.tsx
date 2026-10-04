import { SUMMARY_RANGE_NAMES, summaryRanges } from '@commander/domain';
import { AresText, cn, Led } from '@commander/ui';
import { Eyebrow } from '../todos/detail/parts';
import type { ChatSummaryState } from './chat-summary';
import { type Chat, isWaiting } from './chats';

/*
  Ares in the Chat view (#109): what he judged (someone waiting on the User, with his reason and
  "Not waiting", which can be undone) and Summarise, whose summary shows above the messages. All of
  it is Ares's words, shown through AresText, linking only what the Chat's messages hold.
*/

const action =
  'flex cursor-pointer items-center gap-[9px] border-0 border-r border-line2 bg-transparent px-3.5 font-mono text-label-lg leading-none font-semibold uppercase tracking-label whitespace-nowrap text-ink no-underline hover:bg-raise disabled:cursor-default disabled:text-faint';

const small =
  'flex h-6 cursor-pointer items-center border border-line bg-sheet px-2 font-mono text-label leading-none font-semibold uppercase tracking-label whitespace-nowrap text-ink hover:bg-raise';

// Everything a Chat says: what Ares's words about it may link to.
const wordsOf = (chat: Chat) => [chat.title, ...chat.detail.messages.map((message) => message.text)];

/** Summarise, in the Chat view's actions: Ares summarises the Chat since the User last read it. */
export function SummariseButton({ state, disabled }: { state: ChatSummaryState; disabled?: boolean }) {
  return (
    <button
      type="button"
      className={action}
      onClick={() => state.summarise()}
      disabled={disabled || state.busy}
    >
      {state.busy && <Led size="sm" />}
      Summarise
    </button>
  );
}

/** Ares's flag on the Chat: who is waiting on the User and on what, and "Not waiting". */
export function WaitingNote({ chat, onNotWaiting }: { chat: Chat; onNotWaiting: () => void }) {
  if (!isWaiting(chat) || !chat.waiting) return null;
  return (
    <section
      aria-label="Waiting on you"
      data-testid="chat-waiting"
      className="mt-3 flex items-start gap-3 border border-ink px-3 py-2 shadow-[inset_3px_0_0_var(--ink)]"
    >
      <div className="min-w-0 flex-1">
        <Eyebrow>Waiting on you · Ares</Eyebrow>
        <p className="m-0 mt-1 text-note leading-[19px] text-text" data-testid="chat-waiting-reason">
          <AresText inline text={chat.waiting.reason} sources={wordsOf(chat)} />
        </p>
      </div>
      <button type="button" className={small} onClick={onNotWaiting}>
        Not waiting
      </button>
    </section>
  );
}

/** The summary above the messages, with its range: since I last read, today, this week. */
export function SummaryPanel({ state }: { state: ChatSummaryState }) {
  if (!state.open) return null;
  const { summary } = state;
  return (
    <section
      aria-label="Summary"
      data-testid="chat-summary"
      className="mt-[18px] border border-line bg-sheet px-3 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Eyebrow>Summary · Ares</Eyebrow>
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and form semantics */}
        <div role="group" aria-label="Summarise" className="ml-auto flex">
          {summaryRanges.map((range) => (
            <button
              key={range}
              type="button"
              aria-pressed={state.range === range}
              onClick={() => state.show(range)}
              className={cn(
                small,
                '[&+&]:border-l-0',
                state.range === range && 'bg-ink text-sheet hover:bg-ink',
              )}
            >
              {SUMMARY_RANGE_NAMES[range]}
            </button>
          ))}
        </div>
        <button type="button" className={small} onClick={state.close} aria-label="Close the summary">
          Close
        </button>
      </div>
      <div className="mt-2 text-[14px] leading-[1.5] text-text" data-testid="chat-summary-text">
        {state.busy ? (
          <p className="m-0 flex items-center gap-2 text-note text-muted">
            <Led size="sm" /> Ares is reading the Chat…
          </p>
        ) : state.problem ? (
          <p className="m-0 text-note text-ink">{state.problem}</p>
        ) : summary && summary.text !== null ? (
          <>
            <AresText text={summary.text} sources={summary.sources} />
            <p className="m-0 mt-1.5 font-mono text-label leading-none uppercase tracking-label text-faint">
              {summary.count} {summary.count === 1 ? 'message' : 'messages'}
            </p>
          </>
        ) : (
          summary && <p className="m-0 text-note text-muted">No messages to summarise here.</p>
        )}
      </div>
    </section>
  );
}
