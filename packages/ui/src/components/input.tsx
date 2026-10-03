import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';

export const inputVariants = cva(
  [
    'h-7.5 w-full min-w-0 border border-line bg-sheet px-2.5 text-ink caret-signal',
    'placeholder:text-faint hover:border-muted focus-visible:border-ink',
    'disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:border-signal',
  ],
  {
    variants: {
      font: {
        sans: 'font-sans text-ui',
        /** For codes, IDs and hex values. */
        mono: 'font-mono text-code uppercase tracking-heading',
      },
    },
    defaultVariants: { font: 'sans' },
  },
);

export function Input({
  className,
  font,
  type = 'text',
  ...props
}: ComponentProps<'input'> & VariantProps<typeof inputVariants>) {
  return (
    <input data-slot="input" type={type} className={cn(inputVariants({ font }), className)} {...props} />
  );
}
