import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Led } from './marks';

/**
 * The AI mark: a four-pointed spark, the one glyph that means "Ares" on a control. Drawn in the
 * current colour; the Ares button puts it in the signal colour, which stays reserved for live things
 * and Ares.
 */
export function AresMark({ className, ...props }: ComponentProps<'svg'>) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className={cn('size-3', className)} {...props}>
      <path d="M6 .5 7.25 4.75 11.5 6 7.25 7.25 6 11.5 4.75 7.25.5 6 4.75 4.75Z" fill="currentColor" />
    </svg>
  );
}

const SHARED =
  'inline-flex flex-none cursor-pointer items-center justify-center gap-1.5 border font-mono leading-none font-semibold uppercase tracking-label whitespace-nowrap focus-visible:outline focus-visible:outline-offset-1 focus-visible:outline-ink disabled:cursor-progress disabled:text-faint';

const VARIANTS = {
  // On a row: a small square with the mark alone, quiet until pointed at.
  row: 'size-5 border-transparent bg-transparent p-0 text-muted hover:border-signal hover:text-signal-ink',
  // On a detail pane: the mark and its words on a hard box.
  pane: 'h-6 border-line bg-sheet px-2 text-label text-ink hover:border-signal hover:text-signal-ink [&_svg]:text-signal-ink',
} as const;

/**
 * The Ares button (#193, decision #24): the AI mark on an Item's row or detail pane, and on the few
 * controls that ask Ares for something where they are (the Teams reply box's Draft). On a row it is
 * the mark alone; on a pane, the mark and its words (`label`, "Ask Ares" by default). `busy` shows the
 * lamp while Ares works on it. Its accessible name says what it asks of him.
 */
export function AresButton({
  variant = 'row',
  label,
  busy = false,
  className,
  type = 'button',
  ...props
}: ComponentProps<'button'> & {
  variant?: keyof typeof VARIANTS;
  /** The words beside the mark on a pane ("Ask Ares", "Draft"). Rows show the mark alone. */
  label?: ReactNode;
  busy?: boolean;
}) {
  return (
    <button
      type={type}
      data-slot="ares-button"
      data-busy={busy || undefined}
      className={cn(SHARED, VARIANTS[variant], className)}
      {...props}
    >
      {busy ? <Led size="sm" /> : <AresMark />}
      {variant === 'pane' && (label ?? 'Ask Ares')}
    </button>
  );
}
