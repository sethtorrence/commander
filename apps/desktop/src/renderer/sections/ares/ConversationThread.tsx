import { type ConversationTurn, type ConversationView, MAX_TURN_TEXT } from '@commander/domain';
import { AresText, Button, cn, Kbd, Led } from '@commander/ui';
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ItemStoreClient } from '../../item-store/client';
import { useUpdates } from '../../updates/context';
import { KindTag } from '../todos/detail/parts';
import { kindTag } from '../todos/links';
import type { AutonomyClient } from './activity';
import { AnswerActions } from './ConversationActions';
import { AnswerMade } from './ConversationMade';
import { ConversationUpdate } from './ConversationUpdate';
import {
  answeringTurn,
  type ConversationsClient,
  canSendAgain,
  doingOf,
  linkTarget,
  nameOf,
  refsOf,
} from './conversations';
import { RememberedLines } from './Remembered';
import type { CoreMessages } from './use-conversations';

/*
  One Conversation's thread, as the Ares Section, the Ares button's pop-up (#193) and the Ares panel
  (#235) all draw it, so they can't drift apart: the turns, Ares's answer appearing as he writes it,
  what his Skills did, made or remembered under it, Send again after a failed answer, and the box
  the User writes in, with Send, or Stop while he answers. Each Conversation keeps its own unsent
  words while the thread stays mounted. Enter sends, Shift+Enter makes a new line.
*/

const metaClass = 'font-mono text-label leading-none font-medium uppercase tracking-label text-muted';

/** What the thread asks of the Conversation it shows (useConversations, or the pop-up's useConversation). */
export type ThreadState = {
  view: ConversationView | null;
  // Ares's answers as he writes them, by turn.
  live: ReadonlyMap<number, string>;
  send(text: string): Promise<boolean>;
  stop(): Promise<void>;
  sendAgain(): Promise<void>;
};

const SIZES = {
  // The Ares Section's full-width view: a thread of fixed height, the box can be made taller.
  page: {
    turns: 'h-[420px] px-5 py-4',
    bar: 'px-5',
    input: 'resize-y px-5 py-2.5',
    foot: 'px-2.5',
    rows: 3,
  },
  // The pop-up and the panel: the thread takes the height there is.
  compact: {
    turns: 'min-h-[120px] flex-1 px-3 py-3',
    bar: 'flex-none px-3',
    input: 'resize-none px-3 py-2',
    foot: 'px-2',
    rows: 2,
  },
} as const;

export function ConversationThread({
  state,
  client,
  autonomy,
  itemStore,
  onCoreMessage,
  size = 'page',
  empty,
  placeholder = 'Message Ares…',
  hint = (
    <>
      <Kbd>↵</Kbd> sends · <Kbd>Shift ↵</Kbd> new line
    </>
  ),
  ready = true,
  foundTurn = null,
  onSent,
  onLeave,
  inputRef,
}: {
  state: ThreadState;
  client: ConversationsClient;
  // The gate, for the cards of what Ares did or prepared (#196); without it they don't show.
  autonomy?: AutonomyClient;
  // The Item store, for a meeting's prep an answer made (#198).
  itemStore?: ItemStoreClient;
  onCoreMessage: CoreMessages;
  size?: keyof typeof SIZES;
  // What shows before anything is said; `send` sends a message for the User (a starter).
  empty?: (send: (text: string) => void) => ReactNode;
  placeholder?: string;
  // The line beside Send: which keys do what.
  hint?: ReactNode;
  // Whether there is a Conversation to write in yet (the pop-up makes its own on the first message).
  ready?: boolean;
  // The turn search opened the Conversation at (#195): shown and marked.
  foundTurn?: number | null;
  // The User's message went.
  onSent?: () => void;
  // Open in composer on a draft an answer made took the User elsewhere (#198).
  onLeave?: () => void;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const { view, live } = state;
  const sizes = SIZES[size];
  const own = useRef<HTMLTextAreaElement>(null);
  const input = inputRef ?? own;
  const thread = useRef<HTMLOListElement>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const openId = view?.conversation.id ?? '';
  const draft = drafts[openId] ?? '';
  const answering = answeringTurn(view);
  const tooLong = draft.length > MAX_TURN_TEXT;
  const lastTurn = view?.turns.at(-1);

  // The thread follows what is newest: a new turn, or Ares writing.
  const lastText = lastTurn ? (live.get(lastTurn.id) ?? lastTurn.text) : '';
  useEffect(() => {
    const element = thread.current;
    if (element && lastText !== undefined) element.scrollTop = element.scrollHeight;
  }, [lastText]);

  // Unless search opened it at a turn: then that turn is in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the turn is looked for again as the view changes
  useEffect(() => {
    const element = thread.current;
    const turn = foundTurn === null ? null : element?.querySelector(`[data-turn-id="${foundTurn}"]`);
    if (!element || !turn) return;
    element.scrollTop += turn.getBoundingClientRect().top - element.getBoundingClientRect().top - 16;
  }, [foundTurn, view]);

  const setDraft = (text: string) => setDrafts((current) => ({ ...current, [openId]: text }));

  const send = async (text: string) => {
    if (!ready || answering || !text.trim() || text.length > MAX_TURN_TEXT) return;
    const sentFrom = openId;
    onSent?.();
    if (await state.send(text)) setDrafts((current) => ({ ...current, [sentFrom]: '' }));
    input.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send(draft);
  };

  // What Ares may make clickable: only links the User gave in this Conversation.
  const sources = view?.turns.filter((turn) => turn.by === 'user').map((turn) => turn.text) ?? [];

  return (
    <>
      <ol ref={thread} aria-label="Turns" className={cn('m-0 list-none overflow-y-auto', sizes.turns)}>
        {!view?.turns.length && empty && (
          <li className="text-note text-faint">{empty((text) => void send(text))}</li>
        )}
        {view?.turns.map((turn) => (
          <Turn
            key={turn.id}
            turn={turn}
            text={live.get(turn.id) ?? turn.text}
            sources={sources}
            found={turn.id === foundTurn}
            itemStore={itemStore}
            onLeave={onLeave}
          >
            <RememberedLines turn={turn} client={client} sources={sources} />
            <AnswerActions
              turn={turn}
              client={autonomy}
              onCoreMessage={onCoreMessage}
              last={turn === lastTurn}
              writing={draft !== ''}
              onSettled={() => input.current?.focus()}
            />
          </Turn>
        ))}
      </ol>
      {canSendAgain(view) && (
        <div className={cn('flex items-center justify-end border-t border-line2 py-1.5', sizes.bar)}>
          <Button size="sm" variant="signal" onClick={() => void state.sendAgain()}>
            Send again
          </Button>
        </div>
      )}
      <div className="flex-none border-t border-line">
        <textarea
          ref={input}
          aria-label="Message Ares"
          data-testid="conversation-input"
          placeholder={placeholder}
          value={draft}
          rows={sizes.rows}
          disabled={!ready}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          className={cn(
            'block w-full border-0 bg-sheet font-sans text-[14px] text-ink caret-signal placeholder:text-faint focus-visible:outline-none',
            sizes.input,
          )}
        />
        <div className={cn('flex items-center justify-end gap-2.5 border-t border-line2 py-1.5', sizes.foot)}>
          {tooLong ? (
            <span role="status" className="font-mono text-label uppercase tracking-label text-ink">
              Too long to send
            </span>
          ) : (
            <span className="flex items-center gap-1.5 font-mono text-label uppercase tracking-label text-faint">
              {hint}
            </span>
          )}
          {answering ? (
            <Button size="sm" variant="primary" onClick={() => void state.stop()}>
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={!ready || !draft.trim() || tooLong}
              onClick={() => void send(draft)}
            >
              Send
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * The open Conversation's name over its thread, the Item it is about (opening it where it lives),
 * and Delete; `children` go before Delete (the panel's Full view).
 */
export function ConversationHeading({
  view,
  today,
  onDelete,
  compact = false,
  children,
}: {
  view: ConversationView | null;
  today: string;
  onDelete: () => void;
  compact?: boolean;
  children?: ReactNode;
}) {
  const { open } = useUpdates();
  const about = view?.conversation.about;
  return (
    <div
      className={cn('flex h-9 flex-none items-center gap-3 border-b border-line2', compact ? 'px-3' : 'px-5')}
    >
      <h3 className="m-0 min-w-0 flex-1 truncate text-note font-semibold text-ink">
        {view ? nameOf(view.conversation, today) : 'Conversations'}
      </h3>
      {about && (
        <button
          type="button"
          data-testid="conversation-about"
          onClick={() => open(linkTarget(about))}
          className="flex max-w-[45%] min-w-0 cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 font-mono text-label uppercase tracking-label text-muted hover:text-ink"
          aria-label={`Open ${about.title}`}
        >
          About
          <KindTag>{kindTag(about.kind)}</KindTag>
          <span className="truncate font-sans text-note normal-case tracking-[0]">
            {about.label ?? about.title}
          </span>
        </button>
      )}
      {view && children}
      {view && (
        <Button
          size="sm"
          variant="ghost"
          onClick={onDelete}
          aria-label={`Delete ${nameOf(view.conversation, today)}`}
        >
          Delete
        </Button>
      )}
    </div>
  );
}

/** One turn of a Conversation, the User's or Ares's. */
export function Turn({
  turn,
  text,
  sources,
  itemStore,
  onLeave,
  children,
  found = false,
}: {
  turn: ConversationTurn;
  text: string;
  sources: readonly string[];
  // Where a meeting's prep the answer made is read (#198).
  itemStore?: ItemStoreClient;
  // Open in composer on a draft the answer made took the User elsewhere (#198).
  onLeave?: () => void;
  // What his action Skills did or prepared, under his words (#196).
  children?: ReactNode;
  // The turn search opened the Conversation at (#195): marked.
  found?: boolean;
}) {
  const { open } = useUpdates();
  const refs = useMemo(() => refsOf(turn.links, open), [turn.links, open]);
  const doing = text ? null : doingOf(turn);
  if (turn.by === 'user') {
    return (
      <li
        data-testid="conversation-turn"
        data-by="user"
        data-turn-id={turn.id}
        data-found={found || undefined}
        className="mb-4 flex justify-end"
      >
        <p
          className={cn(
            'm-0 max-w-[80%] border border-line2 bg-raise px-3 py-2 text-[14px] leading-[21px] whitespace-pre-wrap text-ink [overflow-wrap:anywhere]',
            found && 'border-signal',
          )}
        >
          {text}
        </p>
      </li>
    );
  }
  return (
    <li
      data-testid="conversation-turn"
      data-by="ares"
      data-status={turn.status}
      data-turn-id={turn.id}
      data-found={found || undefined}
      className={cn('mb-4 max-w-[88%]', found && '-ml-3 border-l-2 border-signal pl-2.5')}
    >
      <div className={cn(metaClass, 'mb-1.5 flex items-center gap-1.5')}>
        {turn.status === 'streaming' && <Led size="sm" />}
        Ares
      </div>
      {turn.status === 'queued' && (
        <p className="m-0 text-note text-muted" role="status">
          Waiting his turn: Ares is answering in another Conversation.
        </p>
      )}
      {doing && (
        <p className="m-0 text-note text-muted" role="status" data-testid="ares-doing">
          {doing}
        </p>
      )}
      {text && (
        <div data-testid="ares-answer">
          <AresText
            text={text}
            sources={sources}
            refs={refs}
            className="text-[14px] leading-[21px] text-text"
          />
        </div>
      )}
      {turn.updateId !== null && <ConversationUpdate updateId={turn.updateId} />}
      <AnswerMade turn={turn} itemStore={itemStore} onLeave={onLeave} />
      {children}
      {turn.status === 'stopped' && (
        <p className={cn(metaClass, 'mt-1.5')}>{text ? 'Stopped' : 'Stopped before he began'}</p>
      )}
      {turn.status === 'failed' && turn.problem && (
        <p className="m-0 mt-1.5 text-note text-ink" role="status" data-testid="ares-problem">
          {turn.problem}
        </p>
      )}
      {turn.ownKnowledge && text && turn.status !== 'streaming' && (
        <p className={cn(metaClass, 'mt-1.5')} data-testid="own-knowledge">
          From Ares’s own knowledge
        </p>
      )}
    </li>
  );
}
