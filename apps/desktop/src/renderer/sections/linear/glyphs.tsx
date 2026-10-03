import { cn } from '@commander/ui';
import type { ReactNode } from 'react';

/*
  The Linear Section's two glyphs, drawn like the prototype's status marks (.st): square-capped,
  ink only, no colour (accents stay for Badges; orange for live things). A workflow state by its
  type, and a priority as bars.
*/

/** A workflow state's mark, by its type: started half filled, unstarted dashed, closed filled. */
export function StateIcon({ type, className }: { type: string; className?: string }) {
  const box = 'fill-none stroke-current [stroke-width:1.5]';
  const dashed = 'fill-none stroke-muted [stroke-width:1.5] [stroke-dasharray:2.4_1.6]';
  let inner: ReactNode;
  switch (type) {
    case 'started':
      inner = (
        <>
          <rect className={box} x="1.75" y="1.75" width="12.5" height="12.5" />
          <rect className="fill-current" x="4" y="4" width="4" height="8" />
        </>
      );
      break;
    case 'completed':
      inner = (
        <>
          <rect className="fill-current" x="1" y="1" width="14" height="14" />
          <path className="fill-none stroke-sheet [stroke-width:1.8]" d="M4.4 8.1l2.4 2.4 4.8-5" />
        </>
      );
      break;
    case 'canceled':
      inner = (
        <>
          <rect className="fill-muted" x="1" y="1" width="14" height="14" />
          <path className="fill-none stroke-sheet [stroke-width:1.6]" d="M5 5l6 6M11 5l-6 6" />
        </>
      );
      break;
    case 'unstarted':
      inner = <rect className={dashed} x="1.75" y="1.75" width="12.5" height="12.5" />;
      break;
    default:
      // Backlog and triage: dashed and faint.
      inner = <rect className={dashed} x="1.75" y="1.75" width="12.5" height="12.5" opacity={0.55} />;
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={cn('size-[15px] flex-none text-ink', className)}>
      {inner}
    </svg>
  );
}

export const PRIORITY_NAMES = ['No priority', 'Urgent', 'High', 'Medium', 'Low'] as const;

/** A priority as Linear draws it: three bars filled by level, a stamped "!" for urgent, dashes for none. */
export function PriorityIcon({ priority, className }: { priority: number; className?: string }) {
  const name = PRIORITY_NAMES[priority] ?? PRIORITY_NAMES[0];
  // High fills three bars, medium two, low one.
  const filled = priority === 2 ? 3 : priority === 3 ? 2 : priority === 4 ? 1 : 0;
  return (
    <svg
      viewBox="0 0 16 16"
      role="img"
      aria-label={name}
      className={cn('size-[15px] flex-none text-ink', className)}
    >
      {priority === 1 ? (
        <>
          <rect className="fill-current" x="1" y="1" width="14" height="14" />
          <path className="fill-none stroke-sheet [stroke-width:2]" d="M8 4v5M8 11v1.5" />
        </>
      ) : priority === 0 ? (
        <path className="fill-none stroke-faint [stroke-width:1.5]" d="M2 8h2.5M6.75 8h2.5M11.5 8H14" />
      ) : (
        [0, 1, 2].map((bar) => (
          <rect
            key={bar}
            x={2 + bar * 4.5}
            y={10 - bar * 3.5}
            width="3"
            height={4 + bar * 3.5}
            className={bar < filled ? 'fill-current' : 'fill-line'}
          />
        ))
      )}
    </svg>
  );
}
