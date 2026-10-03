import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';

// The prototypes' action buttons (.bar button, .qa button, .mini): mono caps on a hard 1px box.
export const buttonVariants = cva(
  [
    'inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap',
    'border font-mono font-semibold uppercase leading-none',
    'disabled:pointer-events-none disabled:opacity-40',
    '[&_kbd]:h-4 [&_kbd]:min-w-4 [&_kbd]:border-current [&_kbd]:text-label [&_kbd]:text-inherit [&_kbd]:opacity-80',
  ],
  {
    variants: {
      variant: {
        default: 'border-line bg-sheet text-ink hover:bg-raise',
        primary: 'border-ink bg-ink text-sheet hover:opacity-90',
        /** For accepting something Ares suggested: the signal colour marks it as live. */
        signal: 'border-signal bg-sheet text-signal-ink hover:bg-signal hover:text-on-signal',
        ghost: 'border-transparent bg-transparent text-muted hover:bg-raise hover:text-ink',
      },
      size: {
        sm: 'h-5.5 px-[9px] text-label tracking-label',
        default: 'h-7 px-2.5 text-label-lg tracking-label',
        lg: 'h-9 px-3 text-label-lg tracking-caps',
        icon: 'size-7 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  type,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot.Root : 'button';
  return (
    <Component
      data-slot="button"
      type={asChild ? type : (type ?? 'button')}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

/** Buttons that touch share their borders, as in the prototypes' action bars. */
export function ButtonGroup({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="button-group" className={cn('flex [&>*+*]:border-l-0', className)} {...props} />;
}
