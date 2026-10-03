import { ChevronIcon, cn } from '@commander/ui';
import type { ReactNode } from 'react';

const pad = (n: number) => String(n).padStart(2, '0');

const heading =
  'relative m-0 flex h-8 w-full items-center gap-2.5 border-0 border-b border-solid border-line pr-5 pl-13 font-sans text-[12px] leading-none font-bold uppercase tracking-heading text-ink font-stretch-(--stretch-wider)';

/**
 * A numbered group of Todos, headed like the prototype's group headers (.gh). With `onExpandedChange`
 * the header is a button that collapses and expands the group.
 */
export function TodoGroup({
  no,
  title,
  count,
  expanded = true,
  onExpandedChange,
  children,
}: {
  no: string;
  title: string;
  count: number;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  children: ReactNode;
}) {
  const label = (
    <>
      <span className="absolute left-0 w-10 text-center font-mono text-label font-semibold tracking-normal text-muted">
        {no}
      </span>
      {title}
      {onExpandedChange && (
        <ChevronIcon className={cn('text-muted transition-transform', !expanded && '-rotate-90')} />
      )}
      <span className="ml-auto font-mono text-label-lg font-semibold tracking-label text-muted">
        {pad(count)}
      </span>
    </>
  );
  return (
    <section aria-label={title} className="[&+&]:mt-5.5 [&+&>h2]:border-t">
      {onExpandedChange ? (
        <h2 className="m-0 border-line">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => onExpandedChange(!expanded)}
            className={cn(heading, 'cursor-pointer bg-transparent hover:bg-raise')}
          >
            {label}
          </button>
        </h2>
      ) : (
        <h2 className={heading}>{label}</h2>
      )}
      {expanded && children}
    </section>
  );
}
