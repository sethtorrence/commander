import { cva } from 'class-variance-authority';
import type { ComponentProps, ReactNode } from 'react';
import { SheetStrip, type SheetStripProps } from './sheet';

type Size = 'section' | 'dashboard' | 'day';

// Three title sizes from the prototypes: a Section (.sec-h), the Dashboard (.ftop), a Daily Note (.title).
// `short:` and `max-[1440px]:` follow the prototypes' tighter layout on short or narrow windows.
const block = cva('grid grid-cols-[minmax(0,1fr)_auto] items-end border-b border-line bg-sheet', {
  variants: {
    size: {
      section: 'gap-5 pt-5 pr-6 pb-4 pl-13 short:pt-3.5 short:pb-3',
      dashboard: 'gap-6 pt-5.5 pr-5 pb-4.5 pl-13 short:pt-4 short:pb-3.5',
      day: 'gap-6 pt-7.5 pr-7 pb-7.5 pl-16',
    },
  },
});
const heading = cva(
  'm-0 font-sans font-extrabold uppercase tracking-display text-ink font-stretch-(--stretch-widest)',
  {
    variants: {
      size: {
        section: 'text-title leading-[0.9] short:text-[32px]',
        dashboard: 'text-display-sm leading-display max-[1440px]:text-[38px] short:text-[34px]',
        day: 'text-display leading-[0.9]',
      },
    },
  },
);
const subtitle = cva('font-sans font-light tracking-[-0.01em] text-muted [&_b]:font-medium [&_b]:text-text', {
  variants: {
    size: {
      section: 'mt-[9px] text-intro leading-tight',
      dashboard: 'mt-2.5 text-lead leading-tight short:mt-[7px] short:text-[16px]',
      day: 'mt-2.5 text-subtitle leading-[1.15]',
    },
  },
});

export interface SectionHeaderProps extends Omit<ComponentProps<'header'>, 'title'> {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Shown on the right of the title block, e.g. the keys for this Section. */
  aside?: ReactNode;
  /** The title strip above: what this sheet is and its part number (e.g. DSH-2026-274). */
  eyebrow?: ReactNode;
  partNumber?: ReactNode;
  live?: SheetStripProps['live'];
  sheet?: SheetStripProps['sheet'];
  meta?: SheetStripProps['meta'];
  /** Cells straight after the part number, e.g. what Ares is doing (SheetStripStatus). */
  status?: ReactNode;
  size?: Size;
  /** The heading level; a Section's title is its page heading. */
  as?: 'h1' | 'h2';
}

/** The head of a sheet: the title strip with its part-number label, then the big title. */
export function SectionHeader({
  title,
  subtitle: sub,
  aside,
  eyebrow,
  partNumber,
  live,
  sheet,
  meta,
  status,
  size = 'section',
  as: Heading = 'h1',
  className,
  ...props
}: SectionHeaderProps) {
  const strip = eyebrow || partNumber || sheet || meta || status;
  return (
    <header data-slot="section-header" className={className} {...props}>
      {strip && (
        <SheetStrip eyebrow={eyebrow} live={live} partNumber={partNumber} sheet={sheet} meta={meta}>
          {status}
        </SheetStrip>
      )}
      <div className={block({ size })}>
        <div className="min-w-0">
          <Heading className={heading({ size })}>{title}</Heading>
          {sub && <div className={subtitle({ size })}>{sub}</div>}
        </div>
        {aside}
      </div>
    </header>
  );
}
