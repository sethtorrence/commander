import { cn } from '@commander/ui';
import type { ReactNode } from 'react';

/**
 * A Bucket's name as a small square chip (#137): on a thread's row, in the Rules list, in the re-sort
 * preview. `faint` for Unsorted.
 */
export function BucketChip({
  children,
  faint = false,
  className,
}: {
  children: ReactNode;
  faint?: boolean;
  className?: string;
}) {
  return (
    <span
      data-slot="bucket"
      className={cn(
        'inline-flex h-5 max-w-[160px] flex-none items-center border px-[7px] font-mono text-label leading-none font-semibold uppercase tracking-label whitespace-nowrap',
        faint ? 'border-line2 text-faint' : 'border-ink text-ink',
        className,
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}
