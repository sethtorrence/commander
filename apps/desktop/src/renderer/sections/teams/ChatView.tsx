import type { ActivityEntry, ChatMessage, ChatReply, OutgoingChange } from '@commander/domain';
import { cn, Kbd } from '@commander/ui';
import { type ReactNode, useEffect, useRef } from 'react';
import { ItemWarning } from '../../links/ItemWarning';
import { usePeople } from '../../people/context';
import { PersonName } from '../../people/PersonName';
import { ItemBadge, ItemProject, waitingSuggestion } from '../../projects/badges';
import { useProjects } from '../../projects/context';
import { Eyebrow, PanePart } from '../todos/detail/parts';
import { TodoLinks } from '../todos/detail/TodoLinks';
import { timeOfDay, whenShort } from '../todos/when';
import { CHAT_TYPE_NAMES, ChatTypeGlyph, Mark } from './ChatRow';
import { type Chat, mentionsOf, messagesByDay, peopleIn, reactionSummary } from './chats';
import { MessageText, OutLink } from './MessageText';
import { type ChatLink, describeChatEntry } from './teams-chats';
import type { MessageFocus } from './use-teams';

/*
  The Chat view beside the list, after the prototype's reader: the Chat's actions along the top
  (Open in Teams, Project, Mute, Exclude, Summarise), its name, the people in it and its marks (with
  Ares's dashed Badge, Confirm and Change while his filing suggestion waits, #108), what Ares says
  about it (waiting on you, a summary; #109), then its messages by day, newest at the bottom, and a
  side panel with its Project, Links both ways and
  activity log, as in the other detail panes. Message text is untrusted Source content, shown by
  MessageText (text only, no images, web and mail links only).

  Replying (#106): the reply box goes in the `reply` slot under the messages. A reply shows at once
  below them as on its way (or why it is waiting), then as Couldn't sync with Retry if Teams won't
  take it; once Teams has it, it is one of the messages, under Teams's id. Mark as unread (or read)
  sits with the Chat's actions.

  Ares's work (#110): his suggested Todos go beside the messages they came from (`afterMessage`), and
  his suggested reply and Draft come with the reply box in the `reply` slot.
*/

const isWebAddress = (url: string | null): url is string => !!url && /^https?:\/\//i.test(url);

export const action =
  'flex cursor-pointer items-center gap-[9px] border-0 border-r border-line2 bg-transparent px-3.5 font-mono text-label-lg leading-none font-semibold uppercase tracking-label whitespace-nowrap text-ink no-underline hover:bg-raise [&_kbd]:h-[18px] [&_kbd]:text-label';

export function Message({
  message,
  me,
  webUrl,
  focus,
  after,
}: {
  message: ChatMessage;
  me: string | null;
  webUrl: string | null;
  /** Asked for (from the Dashboard): scrolled into view and marked, again on each new ask. */
  focus?: MessageFocus | null;
  /** What goes beside the message: Ares's suggested Todos from it (#110). */
  after?: ReactNode;
}) {
  const element = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focus) element.current?.scrollIntoView?.({ block: 'center' });
  }, [focus]);
  const time = (
    <time
      dateTime={new Date(message.createdAt).toISOString()}
      className="font-mono text-label-lg whitespace-nowrap text-muted tabular-nums"
    >
      {timeOfDay(message.createdAt)}
    </time>
  );
  if (!message.from) {
    // A system event: someone added, the Chat renamed, a call ended.
    return (
      <li
        data-testid="chat-event"
        className="flex items-center gap-2.5 px-3.5 py-1.5 font-mono text-label leading-none uppercase tracking-label text-faint"
      >
        <span className="h-px flex-1 bg-line2" />
        {message.event ?? 'event'} · {timeOfDay(message.createdAt)}
        <span className="h-px flex-1 bg-line2" />
      </li>
    );
  }
  const mine = me !== null && message.from.userId === me;
  const reactions = reactionSummary(message.reactions);
  const mentioned = mentionsOf(message, me);
  return (
    <li
      ref={element}
      data-testid="chat-message"
      data-message-id={message.id}
      data-focused={focus ? '' : undefined}
      aria-label={`${mine ? 'You' : message.from.name} at ${timeOfDay(message.createdAt)}`}
      className={cn(
        'scroll-my-16 border-b border-line2 px-3.5 py-2.5 last:border-b-0',
        mentioned.length && 'shadow-[inset_3px_0_0_var(--ink)]',
        focus && 'bg-signal-focus shadow-[inset_3px_0_0_var(--signal)]',
      )}
    >
      <div className="mb-1 flex items-baseline gap-2.5">
        {mine ? (
          <span className="font-sans text-note font-semibold text-ink">You</span>
        ) : message.from.userId ? (
          <PersonName
            className="font-sans text-note font-semibold text-ink"
            handle={`teams:${message.from.userId}`}
            fallback={message.from.name}
          />
        ) : (
          <span className="font-sans text-note font-semibold text-ink">{message.from.name}</span>
        )}
        {time}
        {message.deleted ? (
          <Mark title="Deleted in Teams">Deleted</Mark>
        ) : (
          message.editedAt !== undefined && (
            <Mark title={`Edited ${whenShort(message.editedAt)}`}>Edited</Mark>
          )
        )}
      </div>
      {message.deleted ? (
        <p className="m-0 text-[14px] text-faint italic">This message was deleted.</p>
      ) : (
        <MessageText
          text={message.text}
          mentions={mentioned}
          webUrl={webUrl}
          className="text-[14px] leading-[1.5] text-text"
        />
      )}
      {!message.deleted && message.attachments.length > 0 && (
        <ul aria-label="Attachments" className="m-0 mt-2 flex list-none flex-wrap gap-2 p-0">
          {message.attachments.map((attachment) => (
            <li key={`${attachment.name}:${attachment.url}`}>
              {isWebAddress(attachment.url) ? (
                <OutLink
                  href={attachment.url}
                  className="inline-flex h-7 items-center gap-2 border border-line px-2.5 font-mono text-label-lg text-ink no-underline hover:bg-raise"
                >
                  <i aria-hidden="true" className="h-3 w-2.5 border-[1.5px] border-muted" />
                  {attachment.name} ↗
                </OutLink>
              ) : (
                <span className="inline-flex h-7 items-center border border-line px-2.5 font-mono text-label-lg text-muted">
                  {attachment.name}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {!message.deleted && reactions.length > 0 && (
        <ul aria-label="Reactions" className="m-0 mt-2 flex list-none flex-wrap gap-1.5 p-0">
          {reactions.map((reaction) => (
            <li
              key={reaction}
              className="inline-flex h-5 items-center border border-line bg-sheet px-[7px] font-mono text-label leading-none font-medium uppercase tracking-label text-muted"
            >
              {reaction}
            </li>
          ))}
        </ul>
      )}
      {after}
    </li>
  );
}

/** A reply written here that Teams doesn't have yet: on its way, waiting, or Couldn't sync with Retry. */
export function Reply({
  reply,
  change,
  waiting,
  onRetry,
}: {
  reply: ChatReply;
  change: OutgoingChange | undefined;
  waiting: string | null;
  onRetry: () => void;
}) {
  const failed = change?.status === 'failed';
  return (
    <li
      data-testid="chat-reply"
      aria-label={`Your reply at ${timeOfDay(reply.createdAt)}`}
      className="border-b border-line2 px-3.5 py-2.5 last:border-b-0"
    >
      <div className="mb-1 flex items-baseline gap-2.5">
        <span className="font-sans text-note font-semibold text-ink">You</span>
        <time
          dateTime={new Date(reply.createdAt).toISOString()}
          className="font-mono text-label-lg whitespace-nowrap text-muted tabular-nums"
        >
          {timeOfDay(reply.createdAt)}
        </time>
        {failed ? (
          <Mark title={change.error ?? 'Teams didn’t take it'}>Couldn’t sync</Mark>
        ) : (
          <Mark title="On its way to Teams">Sending…</Mark>
        )}
      </div>
      <p className="m-0 text-[14px] leading-[1.5] whitespace-pre-wrap text-text [overflow-wrap:anywhere]">
        {reply.text}
      </p>
      {failed ? (
        <CouldntSync change={change} onRetry={onRetry} />
      ) : (
        waiting && (
          <p role="status" className="m-0 mt-1.5 text-note text-muted">
            {waiting}
          </p>
        )
      )}
    </li>
  );
}

/** Couldn't sync with Retry, for a change made here that Teams won't take. */
export function CouldntSync({ change, onRetry }: { change: OutgoingChange; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="mt-2 flex items-center justify-between gap-2.5 border border-ink px-2.5 py-1.5 text-note"
    >
      <span>
        <b className="font-semibold text-ink">Couldn’t sync</b>
        {change.error && <span className="text-muted"> · {change.error}</span>}
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="cursor-pointer border border-ink bg-transparent px-2.5 py-0.5 font-mono text-label-lg font-semibold uppercase tracking-label text-ink hover:bg-raise"
      >
        Retry
      </button>
    </div>
  );
}

export function ChatView({
  chat,
  me,
  focus,
  accountName,
  links,
  history,
  now,
  onFile,
  onMute,
  onExclude,
  onClose,
  onOpenLink,
  outgoing = [],
  waiting = null,
  onRetry = () => {},
  onToggleRead,
  reply,
  actions,
  ares,
  afterMessage,
}: {
  chat: Chat | null;
  /** The User's Teams user id in the Chat's Account. */
  me: string | null;
  /** A message to scroll to and mark (the Dashboard opens a Chat at the message that put it there). */
  focus?: MessageFocus | null;
  /** The Chat's Account, when more than one is connected. */
  accountName: string | null;
  links: ChatLink[];
  history: ActivityEntry[];
  now: number;
  onFile: () => void;
  /** Mutes the Chat, or unmutes it. */
  onMute: () => void;
  /** Asks to exclude the Chat (after a confirmation). */
  onExclude: () => void;
  onClose: () => void;
  onOpenLink: (link: ChatLink) => void;
  /** The Chat's changes still on their way to Teams, or that couldn't sync. */
  outgoing?: OutgoingChange[];
  /** Why they can't go yet (offline, needs reconnecting), when they can't. */
  waiting?: string | null;
  onRetry?: () => void;
  /** Marks the Chat unread (or read, when it is unread); absent when there is nothing to mark. */
  onToggleRead?: (() => void) | null;
  /** The reply box. */
  reply?: ReactNode;
  /** More actions along the top, after Exclude (Summarise, #109). */
  actions?: ReactNode;
  /** What Ares says about the Chat, above its messages (waiting on you, a summary; #109). */
  ares?: ReactNode;
  /** What goes beside a message: Ares's suggested Todos from it (#110). */
  afterMessage?: (message: ChatMessage) => ReactNode;
}) {
  const { projects, archived, projectOf } = useProjects();
  const people = usePeople();
  const project = chat ? projectOf(chat.filing) : undefined;
  const webUrl = chat && isWebAddress(chat.detail.webUrl) ? chat.detail.webUrl : null;
  const readFailed = outgoing.find((change) => change.field === 'read' && change.status === 'failed');
  return (
    <section
      tabIndex={-1}
      aria-label="Chat"
      className="min-w-0 border-l border-line focus-visible:outline-none"
    >
      <div className="sticky top-(--body) flex max-h-[calc(100vh-var(--body))] flex-col">
        <div className="z-2 flex h-11 min-w-0 flex-none items-stretch overflow-x-auto border-b border-line bg-sheet [scrollbar-width:none]">
          {chat && (
            <>
              {webUrl && (
                <OutLink
                  href={webUrl}
                  className={cn(action, 'bg-ink text-sheet hover:bg-ink hover:opacity-90')}
                >
                  Open in Teams <span aria-hidden="true">↗</span>
                </OutLink>
              )}
              <button type="button" onClick={onFile} className={action}>
                <Kbd>B</Kbd>
                Project
              </button>
              {onToggleRead && (
                <button type="button" onClick={onToggleRead} className={action}>
                  <Kbd>Ctrl U</Kbd>
                  {chat.detail.unreadCount > 0 ? 'Mark as read' : 'Mark as unread'}
                </button>
              )}
              <button type="button" onClick={onMute} className={action}>
                {chat.muted ? 'Unmute' : 'Mute'}
              </button>
              <button type="button" onClick={onExclude} className={action}>
                Exclude…
              </button>
              {actions}
            </>
          )}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className={cn(action, 'border-r-0 border-l')}>
            <Kbd>Esc</Kbd>
            Back to the list
          </button>
        </div>
        {chat ? (
          <div className="grid min-h-80 flex-1 grid-cols-[minmax(0,1fr)_clamp(160px,38%,280px)]">
            <div className="min-w-0 overflow-auto px-[22px] pt-[18px] pb-24 [scrollbar-width:thin]">
              <Eyebrow className="flex items-center gap-2">
                <ChatTypeGlyph type={chat.detail.chatType} />
                {CHAT_TYPE_NAMES[chat.detail.chatType]} chat · Teams{accountName && ` · ${accountName}`}
              </Eyebrow>
              <h2 className="mt-2 mb-1.5 font-sans text-[26px] leading-[1.15] font-bold tracking-[-0.015em] text-ink font-stretch-(--stretch-wide) [overflow-wrap:anywhere]">
                {chat.title}
              </h2>
              <p
                data-testid="chat-people"
                className="m-0 font-sans text-[16px] leading-[1.3] font-light text-muted"
              >
                {peopleIn(chat, me, people) || 'No one else'}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {waitingSuggestion(chat) && <ItemProject item={chat} />}
                {chat.muted && <Mark title="Muted: kept and synced, but not counted as unread">Muted</Mark>}
                <ItemWarning item={chat} variant="pane" />
              </div>
              {readFailed && <CouldntSync change={readFailed} onRetry={onRetry} />}
              {ares}
              {chat.detail.messages.length ? (
                messagesByDay(chat.detail.messages, now).map((day) => (
                  <section key={day.key} aria-label={day.label} className="mt-[18px]">
                    <Eyebrow className="mb-2 flex items-center gap-2.5">
                      {day.label}
                      <span className="h-px flex-1 bg-line" />
                    </Eyebrow>
                    <ol className="m-0 list-none border border-line p-0">
                      {day.messages.map((message) => (
                        <Message
                          key={message.id}
                          message={message}
                          me={me}
                          webUrl={webUrl}
                          focus={focus?.chatId === chat.id && focus.messageId === message.id ? focus : null}
                          after={afterMessage?.(message)}
                        />
                      ))}
                    </ol>
                  </section>
                ))
              ) : (
                <p className="hatch mt-[18px] mb-0 border border-line px-2.5 py-2 text-note text-faint">
                  No messages in the last 30 days.
                </p>
              )}
              {chat.detail.replies?.length ? (
                <section aria-label="On its way to Teams" className="mt-[18px]">
                  <Eyebrow className="mb-2 flex items-center gap-2.5">
                    On its way to Teams
                    <span className="h-px flex-1 bg-line" />
                  </Eyebrow>
                  <ol className="m-0 list-none border border-line p-0">
                    {chat.detail.replies.map((each) => (
                      <Reply
                        key={each.clientId}
                        reply={each}
                        change={outgoing.find((change) => change.field === `message:${each.clientId}`)}
                        waiting={waiting}
                        onRetry={onRetry}
                      />
                    ))}
                  </ol>
                </section>
              ) : null}
              {reply ?? (
                <p className="mt-4 mb-0 font-mono text-label leading-tight uppercase tracking-label text-faint">
                  Read-only here for now · reply in Teams
                </p>
              )}
            </div>
            <aside
              aria-label="About this Chat"
              className="min-w-0 overflow-auto border-l border-line2 px-4 pt-[18px] pb-24 [scrollbar-width:thin]"
            >
              <Eyebrow>Project</Eyebrow>
              <button
                type="button"
                onClick={onFile}
                className="mt-2 flex w-full cursor-pointer items-center gap-[9px] border border-line bg-transparent px-2.5 py-1.5 text-left text-note text-text hover:bg-raise"
              >
                <ItemBadge filing={chat.filing} suggestion={waitingSuggestion(chat)} />
                {project ? project.name : 'Unfiled'}
              </button>
              <TodoLinks links={links} onOpen={onOpenLink} />
              <PanePart label="Activity" count={history.length}>
                <ol className="m-0 list-none border border-line p-0">
                  {history.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex justify-between gap-2.5 border-b border-line2 px-2.5 py-[7px] text-note leading-[18px] last:border-b-0"
                    >
                      <span className="text-text">
                        {describeChatEntry(entry, history, [...projects, ...archived], outgoing)}
                      </span>
                      <time
                        dateTime={new Date(entry.at).toISOString()}
                        className="font-mono text-label-lg leading-[18px] whitespace-nowrap text-muted tabular-nums"
                      >
                        {whenShort(entry.at)}
                      </time>
                    </li>
                  ))}
                </ol>
              </PanePart>
            </aside>
          </div>
        ) : (
          <p className="m-0 px-[22px] py-[18px] text-note text-faint">No chat selected.</p>
        )}
      </div>
    </section>
  );
}
