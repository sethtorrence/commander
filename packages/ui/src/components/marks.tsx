import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';

/** A key cap. The `signal` tone marks a key that talks to Ares. */
export function Kbd({ className, tone, ...props }: ComponentProps<'kbd'> & { tone?: 'default' | 'signal' }) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(tone === 'signal' && 'border-signal text-signal-ink', className)}
      {...props}
    />
  );
}

const ledVariants = cva('inline-block shrink-0', {
  variants: {
    size: { default: 'size-[7px]', sm: 'size-1.5' },
    state: {
      on: 'bg-signal',
      /** Hollow: present but not live (e.g. Ares away). */
      off: 'bg-transparent shadow-[inset_0_0_0_1px_var(--muted)]',
      muted: 'bg-muted',
    },
  },
  defaultVariants: { size: 'default', state: 'on' },
});

/** The square indicator lamp that marks live things. */
export function Led({
  className,
  size,
  state,
  ...props
}: ComponentProps<'i'> & VariantProps<typeof ledVariants>) {
  return (
    <i
      aria-hidden="true"
      data-slot="led"
      className={cn(ledVariants({ size, state }), className)}
      {...props}
    />
  );
}
