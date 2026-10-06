import { Popover as PopoverPrimitive } from 'radix-ui';
import { useState } from 'react';
import { cn } from '../lib/cn';
import { usePortalContainer } from '../theme/theme-scope';
import { Button } from './button';

const CHIP =
  'inline-flex h-5 flex-none items-center border bg-sheet px-[7px] font-mono text-label leading-none font-semibold uppercase tracking-label whitespace-nowrap';

/**
 * The warning mark (#69): an outside Item holding instructions aimed at Ares shows it wherever it
 * is listed or opened. On a row, a short mark that reads out (and shows on hover) the whole
 * warning; on a detail pane, the warning in words. There is no pop-up.
 *
 * With `onClear` (#201), the mark offers Not an instruction where it is: on a pane, beside the
 * words; on a row, the mark opens a small panel with the warning, what read like an instruction
 * (`quote`, when known) and Not an instruction, without opening the row.
 */
export function WarningMark({
  message,
  variant = 'row',
  quote,
  onClear,
  className,
}: {
  /** "This issue contains instructions aimed at Ares. He ignored them." */
  message: string;
  variant?: 'row' | 'pane';
  /** What in the Item read like an instruction, word for word, when known. */
  quote?: string | null;
  /** Not an instruction: clears the mark, as the User's correction. */
  onClear?: () => void;
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
        <span className="min-w-0 flex-1">{message}</span>
        {onClear && (
          <Button size="sm" className="self-center" onClick={onClear}>
            Not an instruction
          </Button>
        )}
      </p>
    );
  }
  if (!onClear) {
    return (
      <span
        role="note"
        aria-label={message}
        title={message}
        data-testid="injection-warning"
        className={cn(CHIP, 'border-signal text-signal-ink', className)}
      >
        Aimed at Ares
      </span>
    );
  }
  return <RowMark message={message} quote={quote ?? null} onClear={onClear} className={className} />;
}

// A row's mark that opens its panel: clicks stay off the row (which would open the Item).
function RowMark({
  message,
  quote,
  onClear,
  className,
}: {
  message: string;
  quote: string | null;
  onClear: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const container = usePortalContainer();
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <span
        role="note"
        aria-label={message}
        title={message}
        data-testid="injection-warning"
        className={cn('inline-flex flex-none', className)}
      >
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            aria-label="About this warning"
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            className={cn(
              CHIP,
              'cursor-pointer border-signal text-signal-ink hover:bg-signal hover:text-on-signal focus-visible:outline focus-visible:outline-offset-1 focus-visible:outline-ink',
            )}
          >
            Aimed at Ares
          </button>
        </PopoverPrimitive.Trigger>
      </span>
      <PopoverPrimitive.Portal container={container}>
        <PopoverPrimitive.Content
          aria-label="Warning mark"
          data-testid="injection-warning-panel"
          align="start"
          sideOffset={4}
          onClick={(event) => event.stopPropagation()}
          className="z-50 w-80 border border-signal bg-sheet px-3 py-2.5 text-note leading-[1.35] text-text shadow-[4px_4px_0_var(--line)]"
        >
          <p className="m-0">{message}</p>
          {quote && (
            <blockquote className="m-0 mt-1.5 border-l-2 border-signal pl-2 text-muted">“{quote}”</blockquote>
          )}
          <p className="m-0 mt-2 text-muted">If it’s ordinary text, the mark can go.</p>
          <Button
            size="sm"
            className="mt-2"
            onClick={() => {
              setOpen(false);
              onClear();
            }}
          >
            Not an instruction
          </Button>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/**
 * The small note on an Item Ares sent to no model because it holds one of the User's keys or sign-in
 * tokens (#201). On a row, a short mark that reads out (and shows on hover) the whole note; on a
 * detail pane, the note in words. It never shows the secret.
 */
export function RefusalNote({
  message,
  variant = 'row',
  className,
}: {
  /** "Ares skipped this email: it holds what looks like one of your keys or sign-in tokens, so…" */
  message: string;
  variant?: 'row' | 'pane';
  className?: string;
}) {
  if (variant === 'pane') {
    return (
      <p
        role="note"
        data-testid="refusal-note"
        className={cn(
          'm-0 flex items-baseline gap-2 border border-line px-2.5 py-1.5 text-note leading-[1.35] text-muted',
          className,
        )}
      >
        <span aria-hidden="true" className="font-mono font-bold text-ink">
          ⊘
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
      data-testid="refusal-note"
      className={cn(CHIP, 'border-line text-muted', className)}
    >
      Skipped
    </span>
  );
}
