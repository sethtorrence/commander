import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Led } from './marks';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A drawing sheet: the sheet-coloured panel with a hard edge that every Section and Daily Note sits on.
 * `margin` draws the faint vertical rule beside the numbered margin.
 */
export function Sheet({ className, margin = false, ...props }: ComponentProps<'div'> & { margin?: boolean }) {
  return (
    <div
      data-slot="sheet"
      className={cn(
        'relative min-w-0 border border-line bg-sheet',
        margin &&
          'bg-[linear-gradient(var(--line2),var(--line2))] bg-size-[1px_100%] bg-position-[var(--sheet-margin)_0] bg-no-repeat',
        className,
      )}
      {...props}
    />
  );
}

const cellVariants = cva('flex items-center border-r border-line2 px-3 whitespace-nowrap', {
  variants: {
    tone: {
      default: '',
      /** The sheet's eyebrow: what this sheet is. */
      eyebrow: 'bg-ink font-semibold text-sheet',
      /** A live eyebrow (today, now): on the signal colour. */
      live: 'bg-signal font-semibold text-on-signal',
      /** The part number. */
      part: 'font-semibold text-ink',
      /** Something Ares is doing. */
      signal: 'gap-[7px] text-signal-ink',
    },
  },
  defaultVariants: { tone: 'default' },
});

export function SheetStripCell({
  className,
  tone,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof cellVariants>) {
  return <span data-cell="" className={cn(cellVariants({ tone }), className)} {...props} />;
}

export interface SheetStripProps extends Omit<ComponentProps<'div'>, 'title'> {
  eyebrow?: ReactNode;
  /** Puts the eyebrow on the signal colour (e.g. today's Daily Note). */
  live?: boolean;
  partNumber?: ReactNode;
  /** This sheet's position in its set, e.g. [1, 3] reads "Sheet 01 / 03". */
  sheet?: readonly [number, number];
  /** Cells on the right, before the sheet number. */
  meta?: ReactNode;
}

/** The title strip along a sheet's top edge (.sh-strip): eyebrow, part number, and the sheet number. */
export function SheetStrip({
  eyebrow,
  live,
  partNumber,
  sheet,
  meta,
  children,
  className,
  ...props
}: SheetStripProps) {
  return (
    <div
      data-slot="sheet-strip"
      className={cn(
        'relative z-2 flex h-7.5 items-stretch border-b border-line bg-sheet',
        'font-mono text-label-lg font-medium uppercase leading-none tracking-label text-muted',
        '[&>[data-cell]:last-child]:border-r-0 [&>[data-cell]:last-child]:border-l',
        className,
      )}
      {...props}
    >
      {eyebrow && <SheetStripCell tone={live ? 'live' : 'eyebrow'}>{eyebrow}</SheetStripCell>}
      {partNumber && (
        <SheetStripCell tone="part" data-slot="part-number">
          {partNumber}
        </SheetStripCell>
      )}
      {children}
      <span className="flex-1" aria-hidden="true" />
      {meta}
      {sheet && (
        <SheetStripCell>
          Sheet {pad(sheet[0])} / {pad(sheet[1])}
        </SheetStripCell>
      )}
    </div>
  );
}

/** A strip cell showing what Ares is doing, with a live lamp. */
export function SheetStripStatus({ children, ...props }: ComponentProps<'span'>) {
  return (
    <SheetStripCell tone="signal" {...props}>
      <Led size="sm" />
      {children}
    </SheetStripCell>
  );
}
