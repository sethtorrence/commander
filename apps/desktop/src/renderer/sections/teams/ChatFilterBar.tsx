import { type ChatType, chatTypes } from '@commander/domain';
import { cn, Led } from '@commander/ui';
import { CHAT_TYPE_NAMES } from './ChatRow';
import type { ChatCounts, ChatFilters } from './chats';

const pad = (n: number) => String(n).padStart(2, '0');

const TYPES: { type: ChatType | null; label: string }[] = [
  { type: null, label: 'All chats' },
  ...chatTypes.map((type) => ({ type, label: CHAT_TYPE_NAMES[type] })),
];

/**
 * The Teams filters under the Project filter, after the prototype's Bucket tabs (.bkts): the Chat
 * types with their counts, Unread only with its count, and the thin status line on the right ("Checked
 * 14:02", or the Account's problem). They narrow the list together with the Project filter.
 */
export function ChatFilterBar({
  filters,
  counts,
  onFilters,
  status,
}: {
  filters: ChatFilters;
  counts: ChatCounts;
  onFilters: (change: Partial<ChatFilters>) => void;
  status: { text: string; problem: boolean; checking: boolean };
}) {
  return (
    <div className="flex h-14 flex-none items-stretch border-b border-line">
      <div
        role="tablist"
        aria-label="Chat type"
        className="ml-[41px] flex items-stretch border-l border-line2"
      >
        {TYPES.map(({ type, label }) => {
          const on = filters.type === type;
          const count = counts.types[type ?? 'all'];
          return (
            <button
              key={label}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onFilters({ type })}
              className={cn(
                'flex w-[132px] cursor-pointer flex-col items-start justify-center gap-1.5 border-0 border-r border-line2 bg-transparent px-3.5 text-left',
                on ? 'bg-sheet shadow-[inset_0_-3px_0_var(--ink)]' : 'hover:bg-raise',
              )}
            >
              <span
                className={cn(
                  'font-mono text-label leading-none uppercase tracking-caps whitespace-nowrap',
                  on ? 'font-semibold text-ink' : 'font-medium text-muted',
                )}
              >
                {label}
              </span>
              <span
                className={cn(
                  'font-sans text-[22px] leading-none tabular-nums font-stretch-(--stretch-wide)',
                  count ? 'font-bold text-ink' : 'font-normal text-faint',
                )}
              >
                {pad(count)}
              </span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={filters.unreadOnly}
        onClick={() => onFilters({ unreadOnly: !filters.unreadOnly })}
        className={cn(
          'flex cursor-pointer items-center gap-2.5 border-0 border-r border-line2 px-4 font-mono text-label-lg leading-none font-semibold uppercase tracking-label whitespace-nowrap',
          filters.unreadOnly ? 'bg-ink text-sheet' : 'bg-transparent text-ink hover:bg-raise',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'relative h-4 w-[30px] border-[1.5px]',
            filters.unreadOnly ? 'border-sheet' : 'border-ink',
          )}
        >
          <i
            className={cn(
              'absolute top-0.5 size-[9px]',
              filters.unreadOnly ? 'right-0.5 bg-sheet' : 'left-0.5 bg-muted',
            )}
          />
        </span>
        Unread only
        <span className="tabular-nums">{pad(counts.unread)}</span>
      </button>
      <p
        data-testid="teams-check-status"
        role="status"
        className={cn(
          'm-0 ml-auto flex min-w-0 items-center gap-2 self-center px-4 text-right font-mono text-label leading-tight uppercase tracking-label',
          status.problem ? 'font-semibold text-ink' : 'font-medium text-faint',
        )}
      >
        {status.checking && <Led size="sm" />}
        <span className="truncate">{status.text}</span>
      </p>
    </div>
  );
}
