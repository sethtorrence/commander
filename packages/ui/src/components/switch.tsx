import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';

/**
 * An on/off switch (the prototypes' .tri-tg .sw): a hard-edged slot with a square knob that slides
 * right and lights in the signal colour when on.
 */
export function Switch({
  checked,
  onCheckedChange,
  className,
  ...props
}: Omit<ComponentProps<'button'>, 'onChange'> & {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-slot="switch"
      data-state={checked ? 'on' : 'off'}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        'relative h-4 w-7.5 shrink-0 cursor-pointer border-[1.5px] border-ink bg-transparent p-0',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
      {...props}
    >
      <i
        aria-hidden="true"
        className={cn(
          'absolute top-0.5 block size-[9px]',
          checked ? 'right-0.5 bg-signal' : 'left-0.5 bg-muted',
        )}
      />
    </button>
  );
}
