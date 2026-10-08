import type { Conversation } from '@commander/domain';
import { Button, cn, Led } from '@commander/ui';
import { lastWritten, nameOf } from './conversations';

/*
  The list of Conversations, newest first, as the Ares Section and the Ares panel (#235) both show
  it, with New Conversation over it. Each row says where its Conversation stands: Ares answering
  (or waiting his turn to), a card of his waiting for the User's Confirm, his last answer failed, or
  else when it was last written in. Choosing a row opens it; Delete is on the row the pointer is on.
*/

const metaClass = 'font-mono text-label leading-none font-medium uppercase tracking-label text-muted';

export type ConversationState = 'answering' | 'waiting' | 'failed' | 'idle';

/** Where a Conversation stands, for its row: answering first, then a card waiting, then a failure. */
export function stateOf(
  conversation: Pick<Conversation, 'answering' | 'waiting' | 'failed'>,
): ConversationState {
  if (conversation.answering) return 'answering';
  if (conversation.waiting) return 'waiting';
  return conversation.failed ? 'failed' : 'idle';
}

const STATE_TEXT: Record<Exclude<ConversationState, 'idle'>, string> = {
  answering: 'Answering',
  waiting: 'Waiting for you',
  failed: 'Didn’t finish',
};

export function ConversationList({
  list,
  today,
  openId,
  onOpen,
  onDelete,
  onNew,
  compact = false,
  className,
}: {
  list: readonly Conversation[];
  today: string;
  openId: string | null;
  onOpen: (conversation: Conversation) => void;
  onDelete: (conversation: Conversation) => void;
  onNew: () => void;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div
        className={cn(
          'flex flex-none items-center border-b border-line2',
          compact ? 'px-3 py-1.5' : 'py-2 pr-3 pl-13',
        )}
      >
        <Button size="sm" onClick={onNew}>
          New Conversation
        </Button>
      </div>
      <ul
        aria-label="Conversations"
        data-testid="conversation-list"
        className={cn('m-0 min-h-0 list-none overflow-y-auto p-0', !compact && 'max-h-[520px]')}
      >
        {list.map((conversation) => (
          <ConversationRow
            key={conversation.id}
            conversation={conversation}
            today={today}
            open={conversation.id === openId}
            compact={compact}
            onOpen={() => onOpen(conversation)}
            onDelete={() => onDelete(conversation)}
          />
        ))}
      </ul>
    </div>
  );
}

function ConversationRow({
  conversation,
  today,
  open,
  compact,
  onOpen,
  onDelete,
}: {
  conversation: Conversation;
  today: string;
  open: boolean;
  compact: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const name = nameOf(conversation, today);
  const state = stateOf(conversation);
  return (
    <li
      aria-label={name}
      aria-current={open ? 'true' : undefined}
      data-testid="conversation-row"
      data-state={state}
      className={cn('group flex items-center border-b border-line2', open && 'bg-raise')}
    >
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'flex min-w-0 flex-1 cursor-pointer border-0 bg-transparent pr-2 text-left',
          compact ? 'items-center gap-3 py-1.5 pl-3' : 'flex-col items-start gap-1 py-2 pl-13',
        )}
      >
        <span
          className={cn(
            'min-w-0 truncate text-note text-text',
            compact ? 'flex-1' : 'w-full',
            open && 'font-semibold text-ink',
          )}
        >
          {name}
        </span>
        <span
          data-testid="conversation-state"
          className={cn(
            metaClass,
            'flex flex-none items-center gap-1.5',
            state === 'waiting' && 'text-signal-ink',
            state === 'failed' && 'text-ink',
          )}
        >
          {state === 'answering' && <Led size="sm" />}
          {state === 'idle' ? lastWritten(conversation.updatedAt, today) : STATE_TEXT[state]}
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
