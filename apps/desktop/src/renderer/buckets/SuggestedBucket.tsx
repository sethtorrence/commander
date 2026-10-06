import { Button, cn } from '@commander/ui';
import type { MouseEvent } from 'react';

/*
  Ares's suggested Bucket (#141): an email he wasn't sure about stays Unsorted, wearing his Bucket as
  a dashed chip, with Confirm (sorts it there, as the User) and Change (the Bucket picker, `v`). On a
  thread's row and in the open thread.
*/

const chip =
  'inline-flex h-5 max-w-[160px] flex-none items-center border border-dashed border-ink px-[7px] font-mono text-label leading-none font-semibold uppercase tracking-label whitespace-nowrap text-ink';

/** The dashed chip alone: "Receipts?", named for screen readers as Ares's suggestion. */
export function SuggestedBucketChip({ name, className }: { name: string; className?: string }) {
  return (
    <span
      role="img"
      data-slot="bucket"
      data-suggested
      aria-label={`Ares suggests ${name}`}
      title={`Ares suggests ${name}: confirm it, or change it (V)`}
      className={cn(chip, className)}
    >
      <span className="truncate">{name}?</span>
    </span>
  );
}

/** The dashed chip with Confirm and Change. Clicks don't reach the row beneath. */
export function SuggestedBucket({
  name,
  onConfirm,
  onChange,
  className,
  ...props
}: {
  name: string;
  onConfirm: () => void;
  onChange: () => void;
  className?: string;
  'data-testid'?: string;
}) {
  const quietly = (run: () => void) => (event: MouseEvent) => {
    event.stopPropagation();
    run();
  };
  return (
    <span className={cn('inline-flex flex-none items-center gap-1.5', className)} {...props}>
      <SuggestedBucketChip name={name} />
      <Button size="sm" variant="signal" aria-label={`Confirm ${name}`} onClick={quietly(onConfirm)}>
        Confirm
      </Button>
      <Button size="sm" aria-label="Change the Bucket" onClick={quietly(onChange)}>
        Change
      </Button>
    </span>
  );
}
