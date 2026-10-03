import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';

// Square-capped, mitred strokes, like the prototypes' glyphs.
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'square',
  strokeLinejoin: 'miter',
} as const;

export function ChevronIcon({ className, ...props }: ComponentProps<'svg'>) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className={cn('size-3', className)} {...props}>
      <path d="M2.5 4.5 6 8l3.5-3.5" strokeWidth={1.5} {...stroke} />
    </svg>
  );
}

export function CheckIcon({ className, ...props }: ComponentProps<'svg'>) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className={cn('size-2.5', className)} {...props}>
      <path d="M2.4 6.2l2.3 2.3 4.9-5.1" strokeWidth={1.9} {...stroke} />
    </svg>
  );
}

export function ThemeIcon({ className, ...props }: ComponentProps<'svg'>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn('size-3.5', className)} {...props}>
      <rect x="4.5" y="4.5" width="15" height="15" strokeWidth={1.5} {...stroke} />
      <path d="M4.5 19.5 19.5 4.5V19.5Z" fill="currentColor" />
    </svg>
  );
}
