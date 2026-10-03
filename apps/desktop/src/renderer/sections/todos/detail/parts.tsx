import { cn } from '@commander/ui';
import type { ComponentProps, ReactNode } from 'react';

// Small pieces the detail pane is drawn with, after the prototype's Calendar detail (.cal-det).

const pad = (n: number) => String(n).padStart(2, '0');

/** A small mono caps label (.cal-det .k). */
export function Eyebrow({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'block font-mono text-label leading-none font-semibold uppercase tracking-caps text-muted',
        className,
      )}
      {...props}
    />
  );
}

/** A labelled part of the pane, its label counting what it holds (.rel). */
export function PanePart({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  return (
    <section aria-label={label} className="mt-[18px]">
      <Eyebrow className="mb-2 flex justify-between">
        {label}
        <span className="font-medium text-faint">{pad(count)}</span>
      </Eyebrow>
      {children}
    </section>
  );
}

/** What a part shows when it has nothing to list. */
export function PaneEmpty({ children }: { children: ReactNode }) {
  return <p className="hatch m-0 border border-line px-2.5 py-2 text-note text-faint">{children}</p>;
}

/** A source tag (.tg): the other Item's kind, e.g. EML. */
export function KindTag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-[19px] flex-none items-center border border-line bg-sheet px-1.5 font-mono text-label leading-none font-semibold uppercase tracking-tag text-ink">
      {children}
    </span>
  );
}
