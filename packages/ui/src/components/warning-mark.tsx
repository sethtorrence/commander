import { cn } from '../lib/cn';

/**
 * The warning mark (#69): an outside Item holding instructions aimed at Ares shows it wherever it
 * is listed or opened. On a row, a short mark that reads out (and shows on hover) the whole
 * warning; on a detail pane, the warning in words. There is no pop-up.
 */
export function WarningMark({
  message,
  variant = 'row',
  className,
}: {
  /** "This issue contains instructions aimed at Ares. He ignored them." */
  message: string;
  variant?: 'row' | 'pane';
  className?: string;
}) {
  if (variant === 'pane') {
    return (
      <p
        role="note"
        data-testid="injection-warning"
        className={cn(
          'm-0 flex items-baseline gap-2 border border-signal px-2.5 py-1.5 text-note leading-[1.35] text-text',
          className,
        )}
      >
        <span aria-hidden="true" className="font-mono font-bold text-signal-ink">
          !
        </span>
        <span>{message}</span>
      </p>
    );
  }
  return (
    <span
      role="note"
      aria-label={message}
      title={message}
      data-testid="injection-warning"
      className={cn(
        'inline-flex h-5 flex-none items-center border border-signal bg-sheet px-[7px] font-mono text-label leading-none font-semibold uppercase tracking-label whitespace-nowrap text-signal-ink',
        className,
      )}
    >
      Aimed at Ares
    </span>
  );
}
