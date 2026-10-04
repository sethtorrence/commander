import { cn } from '@commander/ui';
import { usePickBadge } from '../../projects/BadgePicker';
import { ItemBadge, waitingSuggestion } from '../../projects/badges';
import type { CalendarEvent } from './agenda';

/*
  What every view puts on an event (#127): its Badge as a stamp (Ares's dashed one while his
  suggestion waits; a click opens the Badge picker), and the clash mark when it overlaps a busy event
  from another Account.
*/

/** "Clashes with Board prep in your sam@contoso.test calendar". */
export function clashText(other: CalendarEvent): string {
  const where = other.detail.accountEmail ?? other.detail.calendar.name;
  return `Clashes with ${other.title} in your ${where} calendar`;
}

/**
 * The clash mark: solid signal colour, so a clash is seen at a glance. Reads out (and shows on hover)
 * what it clashes with. `small` is the Month grid's: a square with "!".
 */
export function ClashMark({
  clashes,
  small = false,
  className,
}: {
  clashes: readonly CalendarEvent[];
  small?: boolean;
  className?: string;
}) {
  if (!clashes.length) return null;
  const message = clashes.map(clashText).join('. ');
  return (
    <span
      role="note"
      aria-label={message}
      title={message}
      data-testid="clash-mark"
      className={cn(
        'inline-flex flex-none items-center justify-center bg-signal font-mono leading-none font-bold uppercase text-on-signal',
        small ? 'h-3 w-3 text-[8.5px]' : 'h-4 px-[5px] text-[9px] tracking-label',
        className,
      )}
    >
      {small ? '!' : 'Clash'}
    </span>
  );
}

/** An event's Badge as a stamp: a button that opens the Badge picker where the Section has one. */
export function EventStamp({
  event,
  size,
  className,
}: {
  event: CalendarEvent;
  size?: 'sm' | 'default';
  className?: string;
}) {
  const pick = usePickBadge();
  const suggestion = waitingSuggestion(event);
  const badge = <ItemBadge filing={event.filing} suggestion={suggestion} size={size} />;
  if (!pick) return <span className={cn('flex flex-none', className)}>{badge}</span>;
  return (
    <button
      type="button"
      title="Change the Project (B)"
      aria-label={`Project of ${event.title}`}
      onClick={(click) => {
        click.stopPropagation();
        pick(
          {
            id: event.id,
            title: event.title,
            filing: event.filing,
            filingSuggestion: event.filingSuggestion,
          },
          click.currentTarget,
        );
      }}
      className={cn(
        'flex flex-none cursor-pointer border-0 bg-transparent p-0 hover:outline hover:outline-offset-1 hover:outline-ink focus-visible:outline focus-visible:outline-offset-1 focus-visible:outline-ink',
        className,
      )}
    >
      {badge}
    </button>
  );
}
