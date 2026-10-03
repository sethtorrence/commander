import { cn, THEMES, type Theme, ThemeScope } from '@commander/ui';
import type { ReactNode } from 'react';

/** One gallery plate: a numbered group header, then the same specimen in the dark and light themes. */
export function Plate({
  no,
  title,
  note,
  stacked = false,
  children,
}: {
  no: string;
  title: string;
  note?: string;
  /** Page-scale specimens show dark above light instead of side by side. */
  stacked?: boolean;
  children: (theme: Theme) => ReactNode;
}) {
  const id = `plate-${no}`;
  return (
    <section aria-labelledby={id} data-testid={id} className="border-b border-line">
      <h2
        id={id}
        className="relative m-0 flex h-8 items-center gap-2.5 border-b border-line pr-5 pl-13 font-sans text-[12px] leading-none font-bold uppercase tracking-heading text-ink font-stretch-(--stretch-wider)"
      >
        <span className="absolute left-0 w-10 text-center font-mono text-label font-semibold tracking-code text-muted">
          {no}
        </span>
        {title}
        {note && (
          <span className="ml-auto font-mono text-label-lg font-semibold tracking-label text-muted">
            {note}
          </span>
        )}
      </h2>
      <div className={cn('grid', stacked ? 'grid-cols-1' : 'grid-cols-2')}>
        {THEMES.map((theme) => (
          <ThemeScope
            key={theme}
            theme={theme}
            data-testid={`${id}-${theme}`}
            className={cn(
              'relative min-w-0 bg-sheet',
              stacked ? 'border-b border-line last:border-b-0' : 'border-r border-line last:border-r-0',
            )}
          >
            <div className="flex h-6 items-center border-b border-line2 px-3.5 font-mono text-tiny leading-none font-semibold uppercase tracking-wide text-faint">
              {theme === 'dark' ? 'Dark · graphite' : 'Light · concrete'}
            </div>
            {children(theme)}
          </ThemeScope>
        ))}
      </div>
    </section>
  );
}

/** A small mono caption under or beside a specimen. */
export function Caption({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'font-mono text-tiny leading-[1.4] font-medium uppercase tracking-caps text-muted',
        className,
      )}
    >
      {children}
    </span>
  );
}
