import { cn } from '@commander/ui';
import { useEffect, useRef } from 'react';
import { ItemWarning } from '../../links/ItemWarning';
import { usePickBadge } from '../../projects/BadgePicker';
import { ItemBadge, useAccentBar } from '../../projects/badges';
import { Tag } from '../linear/IssueRow';
import type { AgendaEntry } from './agenda';

/** The calendar's colour, as a small square (Google's colour for it). */
export function CalendarSwatch({ colour, className }: { colour: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block h-2.5 w-2.5 flex-none border border-line', className)}
      style={{ background: colour }}
    />
  );
}

function EventBadge({ entry }: { entry: AgendaEntry }) {
  const pick = usePickBadge();
  const { event } = entry;
  const bar = useAccentBar(event.filing);
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
          data-item-id={event.id}
          title="Change the Project (B)"
          aria-label={`Project of ${event.title}`}
          onClick={(click) => {
            click.stopPropagation();
            pick({ id: event.id, title: event.title, filing: event.filing }, click.currentTarget);
          }}
          className="flex cursor-pointer border-0 bg-transparent p-0 hover:outline hover:outline-offset-1 hover:outline-ink focus-visible:outline focus-visible:outline-offset-1 focus-visible:outline-ink"
        >
          <ItemBadge filing={event.filing} />
        </button>
      ) : (
        <ItemBadge filing={event.filing} />
      )}
    </>
  );
}

/**
 * One event on one day of the Agenda: its time, calendar colour, Badge and title, then its Account
 * (when more than one is connected) and where it is.
 */
export function EventRow({
  entry,
  selected,
  account,
  compact = false,
  onOpen,
}: {
  entry: AgendaEntry;
  selected: boolean;
  /** The Account's address, when more than one is connected. */
  account: string | null;
  compact?: boolean;
  onOpen: () => void;
}) {
  const row = useRef<HTMLLIElement>(null);
  const { event } = entry;
  const declined = event.detail.myResponse === 'declined';
  useEffect(() => {
    if (selected) row.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  return (
    // Opening with the mouse; the keyboard moves the selection with j and k and opens with Enter.
    // biome-ignore lint/a11y/useKeyWithClickEvents: j/k and Enter work from the keyboard (CalendarSheet's shortcuts)
    <li
      ref={row}
      aria-current={selected || undefined}
      aria-label={`${entry.time}${entry.until ? `–${entry.until}` : ''} ${event.title}`}
      data-testid="calendar-event"
      data-item-id={event.id}
      onClick={onOpen}
      className={cn(
        'relative flex min-h-10 cursor-default items-start border-b border-line2 py-[5px] pr-5 pl-13',
        selected
          ? 'bg-signal-focus shadow-[inset_3px_0_0_var(--signal)]'
          : 'hover:bg-[color-mix(in_srgb,var(--raise)_55%,transparent)]',
      )}
    >
      <span className="w-[92px] flex-none font-mono text-code-lg leading-[30px] tracking-mono whitespace-nowrap text-ink tabular-nums">
        {entry.time}
        {entry.until && <span className="text-muted">–{entry.until}</span>}
      </span>
      <span className="grid h-7.5 w-5 flex-none place-items-center" title={event.detail.calendar.name}>
        <CalendarSwatch colour={event.detail.calendar.colour} />
      </span>
      <span className="ml-1.5 flex h-7.5 w-[25px] flex-none items-center">
        <EventBadge entry={entry} />
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate pl-2.5 text-row leading-[30px]',
          declined ? 'text-faint line-through decoration-1' : 'text-text',
        )}
      >
        {event.title}
      </span>
      <span className="mt-[5px] ml-3 flex flex-none items-center gap-1.5">
        <ItemWarning item={event} />
        {!compact && event.detail.location && (
          <Tag title={event.detail.location}>{event.detail.location}</Tag>
        )}
        {!compact && !event.detail.busy && <Tag>Free</Tag>}
        {account && !compact && <Tag className="border-dashed">{account}</Tag>}
      </span>
    </li>
  );
}
