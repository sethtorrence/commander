import type { ChatType } from '@commander/domain';
import { cn } from '@commander/ui';
import { useEffect, useRef } from 'react';
import { ItemWarning } from '../../links/ItemWarning';
import { usePeople } from '../../people/context';
import { usePickBadge } from '../../projects/BadgePicker';
import { ItemBadge, useAccentBar } from '../../projects/badges';
import { whenShort } from '../todos/when';
import { type Chat, isUnread, isWaiting, latestLine, mentionsUser } from './chats';

const pad = (n: number, width = 3) => String(n).padStart(width, '0');

export const CHAT_TYPE_NAMES: Record<ChatType, string> = {
  'one-on-one': 'One-to-one',
  group: 'Group',
  meeting: 'Meeting',
};

const GLYPHS: Record<ChatType, string> = { 'one-on-one': '1:1', group: 'GRP', meeting: 'MTG' };

/** The Chat-type glyph: a small mono stamp, 1:1, GRP or MTG. */
export function ChatTypeGlyph({ type, className }: { type: ChatType; className?: string }) {
  return (
    <span
      role="img"
      aria-label={`${CHAT_TYPE_NAMES[type]} chat`}
      title={`${CHAT_TYPE_NAMES[type]} chat`}
      className={cn(
        'inline-grid h-[18px] w-[30px] flex-none place-items-center border border-line font-mono text-micro leading-none font-semibold tracking-tag text-muted',
        type === 'meeting' && 'border-dashed',
        className,
      )}
    >
      {GLYPHS[type]}
    </span>
  );
}

/** A small mono mark beside a Chat's name: `@`, Muted. */
export function Mark({ children, title, strong }: { children: string; title: string; strong?: boolean }) {
  return (
    <span
      role="img"
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex h-[18px] flex-none items-center border px-1.5 font-mono text-label leading-none font-semibold uppercase tracking-label',
        strong ? 'border-ink bg-ink text-sheet' : 'border-line text-muted',
      )}
    >
      {children}
    </span>
  );
}

/**
 * The Chat's Badge, with its Project's accent as the row's thin left bar, or Ares's dashed Badge
 * while his suggestion waits. Clicking it opens the Badge picker, as `b` does (with Confirm on top
 * for his suggestion).
 */
function ChatBadge({ chat }: { chat: Chat }) {
  const pick = usePickBadge();
  const bar = useAccentBar(chat.filing);
  return (
    <>
      {bar && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-px bottom-0 left-[39px] w-0.5"
          style={{ background: bar }}
        />
      )}
      {pick ? (
        <button
          type="button"
          data-item-id={chat.id}
          title="Change the Project (B)"
          aria-label={`Project of ${chat.title}`}
          onClick={(event) => {
            event.stopPropagation();
            pick(
              {
                id: chat.id,
                title: chat.title,
                filing: chat.filing,
                filingSuggestion: chat.filingSuggestion,
              },
              event.currentTarget,
            );
          }}
          className="flex cursor-pointer border-0 bg-transparent p-0 hover:outline hover:outline-offset-1 hover:outline-ink focus-visible:outline focus-visible:outline-offset-1 focus-visible:outline-ink"
        >
          <ItemBadge filing={chat.filing} suggestion={chat.filingSuggestion} />
        </button>
      ) : (
        <ItemBadge filing={chat.filing} suggestion={chat.filingSuggestion} />
      )}
    </>
  );
}

/**
 * A Chat's row, after the prototype's message rows: number, Badge, name, its marks (`@` for an
 * unread mention of the User, Waiting when Ares judges someone is waiting on them, Muted, the
 * warning mark) and the latest message's time; then the
 * Chat-type glyph, the latest message as one line with its sender, and the unread count.
 */
export function ChatRow({
  chat,
  number,
  me,
  selected,
  onOpen,
}: {
  chat: Chat;
  number: number;
  /** The User's Teams user id in the Chat's Account. */
  me: string | null;
  selected: boolean;
  onOpen: () => void;
}) {
  const row = useRef<HTMLLIElement>(null);
  const latest = latestLine(chat, me, usePeople());
  const unread = isUnread(chat);
  useEffect(() => {
    if (selected) row.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: j/k and Enter work from the keyboard (TeamsSheet's shortcuts)
    <li
      ref={row}
      aria-current={selected || undefined}
      aria-label={chat.title}
      data-testid="teams-chat"
      data-unread={unread || undefined}
      onClick={onOpen}
      className={cn(
        'relative cursor-default border-b border-line2 py-2.5 pr-4 pl-13',
        selected
          ? 'bg-signal-focus shadow-[inset_3px_0_0_var(--signal)]'
          : 'hover:bg-[color-mix(in_srgb,var(--raise)_55%,transparent)]',
      )}
    >
      <span
        className={cn(
          'absolute top-2.5 left-0 w-10 text-center font-mono text-label leading-5',
          selected ? 'font-semibold text-signal-ink' : 'font-medium text-faint',
        )}
      >
        {pad(number)}
      </span>
      <div className="flex items-center gap-2.5">
        <span className="flex h-5 w-[25px] flex-none items-center">
          <ChatBadge chat={chat} />
        </span>
        <span
          className={cn(
            'min-w-0 truncate text-row leading-5',
            unread ? 'font-semibold text-ink' : 'font-medium text-text',
            chat.muted && 'text-muted',
          )}
        >
          {chat.title}
        </span>
        <span className="flex flex-none items-center gap-1.5">
          {mentionsUser(chat) && (
            <Mark title="An unread message mentions you" strong>
              @
            </Mark>
          )}
          {isWaiting(chat) && (
            <Mark title="Ares: someone here is waiting on you" strong>
              Waiting
            </Mark>
          )}
          {chat.muted && <Mark title="Muted">Muted</Mark>}
          <ItemWarning item={chat} />
        </span>
        <span className="ml-auto flex-none font-mono text-label-lg leading-5 tracking-mono text-muted tabular-nums">
          {latest ? whenShort(latest.at) : ''}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2.5">
        <ChatTypeGlyph type={chat.detail.chatType} className="ml-[1px]" />
        <span
          className="min-w-0 flex-1 truncate text-note leading-[18px] text-muted"
          data-testid="teams-chat-latest"
        >
          {latest ? (
            <>
              <span className="font-semibold text-text" title={latest.title}>
                {latest.sender}:
              </span>{' '}
              {latest.text}
            </>
          ) : (
            <span className="text-faint">No messages yet</span>
          )}
        </span>
        {chat.detail.unreadCount > 0 && (
          <span
            role="img"
            title={`${chat.detail.unreadCount} unread`}
            aria-label={`${chat.detail.unreadCount} unread`}
            className={cn(
              'inline-flex h-[18px] min-w-[22px] flex-none items-center justify-center px-1 font-mono text-label leading-none font-semibold tabular-nums',
              unread ? 'bg-ink text-sheet' : 'border border-line text-muted',
            )}
          >
            {pad(chat.detail.unreadCount, 2)}
          </span>
        )}
      </div>
    </li>
  );
}
