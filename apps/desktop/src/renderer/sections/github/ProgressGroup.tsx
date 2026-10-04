import { ChevronIcon, cn } from '@commander/ui';
import type { ReactNode } from 'react';
import type { SkillProgress } from './work';

const pad = (n: number) => String(n).padStart(2, '0');

/** A thin bar: how much of a map or milestone is done. */
export function ProgressBar({
  done,
  total,
  label,
  className,
}: {
  done: number;
  total: number;
  label: string;
  className?: string;
}) {
  const share = total > 0 ? Math.min(1, done / total) : 0;
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      className={cn('block h-1 overflow-hidden bg-line2', className)}
    >
      <span className="block h-full bg-ink" style={{ width: `${share * 100}%` }} />
    </span>
  );
}

/**
 * A map or a milestone of build tickets in the Issues view (#120), headed like the Section's other
 * groups, with its progress line ("15 of 26 decided") and a thin progress bar. Collapsed by default:
 * long-lived tickets read as one line of progress, not dozens of old open issues.
 */
export function ProgressGroup({
  no,
  title,
  count,
  progress,
  expanded,
  onExpandedChange,
  children,
}: {
  no: string;
  title: string;
  /** How many of its issues are listed. */
  count: number;
  progress: SkillProgress;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children: ReactNode;
}) {
  const kind = progress.kind === 'map' ? 'Map' : 'Milestone';
  return (
    <section aria-label={`${kind}: ${title}`} className="mt-5.5 [&>h2]:border-t">
      <h2 className="m-0 border-line">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => onExpandedChange(!expanded)}
          className="relative m-0 flex h-10 w-full cursor-pointer items-center gap-2.5 border-0 border-b border-solid border-line bg-transparent pr-5 pl-13 text-left hover:bg-raise"
        >
          <span className="absolute left-0 w-10 text-center font-mono text-label font-semibold tracking-normal text-muted">
            {no}
          </span>
          <span className="font-mono text-label font-semibold uppercase tracking-label text-muted">
            {kind}
          </span>
          <span className="min-w-0 truncate font-sans text-[12px] leading-none font-bold uppercase tracking-heading text-ink font-stretch-(--stretch-wider)">
            {title}
          </span>
          <ChevronIcon
            className={cn('flex-none text-muted transition-transform', !expanded && '-rotate-90')}
          />
          <span className="ml-auto flex flex-none items-center gap-3">
            <span data-testid="github-progress-line" className="text-note leading-none text-text">
              {progress.line}
            </span>
            <ProgressBar
              done={progress.done}
              total={progress.total}
              label={`${title} progress`}
              className="w-24"
            />
            <span className="font-mono text-label-lg font-semibold tracking-label text-muted">
              {pad(count)}
            </span>
          </span>
        </button>
      </h2>
      {expanded && children}
    </section>
  );
}
