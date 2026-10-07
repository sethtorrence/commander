import { type Conversation, type ConversationTurn, MAX_TURN_TEXT } from '@commander/domain';
import { AresText, Button, cn, Kbd, Led } from '@commander/ui';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useReveal } from '../../frame/reveal';
import { SettingsGroup } from '../../settings/parts';
import { useUpdates } from '../../updates/context';
import { KindTag } from '../todos/detail/parts';
import { kindTag } from '../todos/links';
import { ConversationUpdate } from './ConversationUpdate';
import {
  answeringTurn,
  CONVERSATIONS_REVEAL,
  type ConversationsClient,
  canSendAgain,
  doingOf,
  lastWritten,
  linkTarget,
  nameOf,
  refsOf,
} from './conversations';
import { type CoreMessages, useConversations } from './use-conversations';

/*
  Conversations (#191): talking to Ares in the Ares Section. The list of Conversations, newest first,
  beside the open one; opening the Section lands on today's, and New Conversation starts another.
  Type and press Enter (Shift+Enter for a new line): Ares's answer appears as he writes it, drawn with
  AresText (text only, nothing loaded, and only a link the User gave is clickable), with "From
  Ares's own knowledge" under an answer that came from the model rather than the User's data. With
  his Skills (#192) he says what he is doing while one runs ("Looking it up…"); each Item his answer
  rests on is a link that opens it in its Section, and an Update he gave shows under his words with
  its lines and actions, as in the Update panel. Stop
  ends it early and keeps what he wrote; a failed answer says why in his voice, and Send again asks
  him once more. Several run at once; with a model on this machine an answer may wait its turn, and
  says so. Delete removes one, with Undo in the toast. Each Conversation keeps its own unsent words.
  One started from an Item with the Ares button (#193) names that Item under its title, opening it
  where it lives; Open in Ares on the pop-up opens it here.
*/

const pad = (n: number) => String(n).padStart(2, '0');
const metaClass = 'font-mono text-label leading-none font-medium uppercase tracking-label text-muted';

export function Conversations({
  client,
  shown,
  onCoreMessage,
  no = 'A4',
}: {
  client: ConversationsClient;
  shown: boolean;
  onCoreMessage: CoreMessages;
  no?: string;
}) {
  const state = useConversations(client, shown, onCoreMessage);
  const { today, list, view, live } = state;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const thread = useRef<HTMLOListElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const openId = view?.conversation.id ?? null;
  const draft = openId ? (drafts[openId] ?? '') : '';
  const answering = answeringTurn(view);
  const tooLong = draft.length > MAX_TURN_TEXT;
  const { open: openItem } = useUpdates();
  const group = useRef<HTMLDivElement>(null);

  // The Ares button's pop-up moved a Conversation here (#193): it opens, in view.
  useReveal(CONVERSATIONS_REVEAL, (conversationId) => {
    void state.reveal(conversationId).then(() =>
      // Once the Section is shown.
      requestAnimationFrame(() => group.current?.scrollIntoView?.({ block: 'start' })),
    );
  });

  // The thread follows what is newest: a new turn, or Ares writing.
  const lastText = view?.turns.at(-1)
    ? (live.get(view.turns.at(-1)?.id ?? 0) ?? view.turns.at(-1)?.text)
    : '';
  useEffect(() => {
    const element = thread.current;
    if (element && lastText !== undefined) element.scrollTop = element.scrollHeight;
  }, [lastText]);

  const setDraft = (text: string) => {
    if (openId) setDrafts((current) => ({ ...current, [openId]: text }));
  };

  const send = async () => {
    if (!openId || answering || !draft.trim() || tooLong) return;
    const sentTo = openId;
    if (await state.send(draft)) setDrafts((current) => ({ ...current, [sentTo]: '' }));
    input.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  // What Ares may make clickable: only links the User gave in this Conversation.
  const sources = view?.turns.filter((turn) => turn.by === 'user').map((turn) => turn.text) ?? [];

  return (
    <SettingsGroup
      no={no}
      title="Conversations"
      note={`${pad(list.length)} Conversations`}
      data-testid="conversations"
    >
      <div
        ref={group}
        className="grid scroll-mt-(--body) grid-cols-[260px_minmax(0,1fr)] border-b border-line2"
      >
        <div className="border-r border-line2">
          <div className="flex items-center border-b border-line2 py-2 pr-3 pl-13">
            <Button size="sm" onClick={() => void state.startNew()}>
              New Conversation
            </Button>
          </div>
          <ul
            aria-label="Conversations"
            data-testid="conversation-list"
            className="m-0 max-h-[520px] list-none overflow-y-auto p-0"
          >
            {list.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                today={today}
                open={conversation.id === openId}
                onOpen={() => void state.open(conversation.id)}
                onDelete={() => void state.remove(conversation)}
              />
            ))}
          </ul>
        </div>
        <div className="flex min-w-0 flex-col" data-testid="conversation-thread">
          <div className="flex h-9 items-center gap-3 border-b border-line2 px-5">
            <h3 className="m-0 min-w-0 flex-1 truncate text-note font-semibold text-ink">
              {view ? nameOf(view.conversation, today) : 'Conversations'}
            </h3>
            {view?.conversation.about && (
              <button
                type="button"
                data-testid="conversation-about"
                onClick={() => {
                  const about = view.conversation.about;
                  if (about) openItem(linkTarget(about));
                }}
                className="flex max-w-[45%] min-w-0 cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 font-mono text-label uppercase tracking-label text-muted hover:text-ink"
                aria-label={`Open ${view.conversation.about.title}`}
              >
                About
                <KindTag>{kindTag(view.conversation.about.kind)}</KindTag>
                <span className="truncate font-sans text-note normal-case tracking-[0]">
                  {view.conversation.about.label ?? view.conversation.about.title}
                </span>
              </button>
            )}
            {view && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void state.remove(view.conversation)}
                aria-label={`Delete ${nameOf(view.conversation, today)}`}
              >
                Delete
              </Button>
            )}
          </div>
          <ol ref={thread} aria-label="Turns" className="m-0 h-[420px] list-none overflow-y-auto px-5 py-4">
            {view && !view.turns.length && (
              <li className="text-note text-faint">
                Ask Ares anything: what’s on today, what you missed, where that email went. He looks it up in
                what Commander holds and links what he found; general questions he answers from what he knows.
              </li>
            )}
            {view?.turns.map((turn) => (
              <Turn key={turn.id} turn={turn} text={live.get(turn.id) ?? turn.text} sources={sources} />
            ))}
          </ol>
          {canSendAgain(view) && (
            <div className="flex items-center justify-end border-t border-line2 px-5 py-2">
              <Button size="sm" variant="signal" onClick={() => void state.sendAgain()}>
                Send again
              </Button>
            </div>
          )}
          <div className="border-t border-line">
            <textarea
              ref={input}
              aria-label="Message Ares"
              data-testid="conversation-input"
              placeholder="Message Ares…"
              value={draft}
              rows={3}
              disabled={!view}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              className="block w-full resize-y border-0 bg-sheet px-5 py-2.5 font-sans text-[14px] text-ink caret-signal placeholder:text-faint focus-visible:outline-none"
            />
            <div className="flex items-center justify-end gap-2.5 border-t border-line2 px-2.5 py-1.5">
              {tooLong ? (
                <span role="status" className="font-mono text-label uppercase tracking-label text-ink">
                  Too long to send
                </span>
              ) : (
                <span className="flex items-center gap-1.5 font-mono text-label uppercase tracking-label text-faint">
                  <Kbd>↵</Kbd> sends · <Kbd>Shift ↵</Kbd> new line
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
                  disabled={!draft.trim() || tooLong}
                  onClick={() => void send()}
                >
                  Send
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </SettingsGroup>
  );
}

function ConversationRow({
  conversation,
  today,
  open,
  onOpen,
  onDelete,
}: {
  conversation: Conversation;
  today: string;
  open: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const name = nameOf(conversation, today);
  return (
    <li
      aria-label={name}
      aria-current={open ? 'true' : undefined}
      data-testid="conversation-row"
      className={cn('group flex items-center border-b border-line2', open && 'bg-raise')}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-1 border-0 bg-transparent py-2 pr-2 pl-13 text-left"
      >
        <span className={cn('w-full truncate text-note text-text', open && 'font-semibold text-ink')}>
          {name}
        </span>
        <span className={cn(metaClass, 'flex items-center gap-1.5')}>
          {conversation.answering && <Led size="sm" />}
          {conversation.answering ? 'Answering' : lastWritten(conversation.updatedAt, today)}
        </span>
      </button>
      <Button
        size="sm"
        variant="ghost"
        className="mr-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={`Delete ${name}`}
        onClick={onDelete}
      >
        Delete
      </Button>
    </li>
  );
}

/** One turn of a Conversation, the User's or Ares's (also drawn in the Ares button's pop-up, #193). */
export function Turn({
  turn,
  text,
  sources,
}: {
  turn: ConversationTurn;
  text: string;
  sources: readonly string[];
}) {
  const { open } = useUpdates();
  const refs = useMemo(() => refsOf(turn.links, open), [turn.links, open]);
  const doing = text ? null : doingOf(turn);
  if (turn.by === 'user') {
    return (
      <li data-testid="conversation-turn" data-by="user" className="mb-4 flex justify-end">
        <p className="m-0 max-w-[80%] border border-line2 bg-raise px-3 py-2 text-[14px] leading-[21px] whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
          {text}
        </p>
      </li>
    );
  }
  return (
    <li data-testid="conversation-turn" data-by="ares" data-status={turn.status} className="mb-4 max-w-[88%]">
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
