import type { GitHubCheck, GitHubCheckState } from '@commander/domain';
import { cn } from '@commander/ui';
import type { ReactNode } from 'react';
import type { WorkState } from './work';

/*
  The GitHub Section's glyphs, drawn like the Linear Section's and the prototype's status marks
  (.st): square-capped, ink only, no colour (accents stay for Badges; orange for live things). A pull
  request's or issue's state, and a check's state.
*/

const box = 'fill-none stroke-current [stroke-width:1.5]';
const dashed = 'fill-none stroke-muted [stroke-width:1.5] [stroke-dasharray:2.4_1.6]';

/** Open outlined, draft dashed, merged filled with a merge mark, closed filled grey with a cross. */
export function WorkStateIcon({
  state,
  issue = false,
  className,
}: {
  state: WorkState;
  /** An issue: open shows a dot, closed a tick. */
  issue?: boolean;
  className?: string;
}) {
  let inner: ReactNode;
  switch (state) {
    case 'open':
      inner = (
        <>
          <rect className={box} x="1.75" y="1.75" width="12.5" height="12.5" />
          {issue ? (
            <rect className="fill-current" x="6" y="6" width="4" height="4" />
          ) : (
            <path
              className="fill-none stroke-current [stroke-width:1.5]"
              d="M5.5 4.5v7M10.5 7v4.5M5.5 4.5h3"
            />
          )}
        </>
      );
      break;
    case 'draft':
      inner = <rect className={dashed} x="1.75" y="1.75" width="12.5" height="12.5" />;
      break;
    case 'merged':
      inner = (
        <>
          <rect className="fill-current" x="1" y="1" width="14" height="14" />
          <path className="fill-none stroke-sheet [stroke-width:1.6]" d="M5.5 4v8M5.5 7.5c0 2 5 1 5 4.5" />
        </>
      );
      break;
    case 'closed':
      inner = issue ? (
        <>
          <rect className="fill-current" x="1" y="1" width="14" height="14" />
          <path className="fill-none stroke-sheet [stroke-width:1.8]" d="M4.4 8.1l2.4 2.4 4.8-5" />
        </>
      ) : (
        <>
          <rect className="fill-muted" x="1" y="1" width="14" height="14" />
          <path className="fill-none stroke-sheet [stroke-width:1.6]" d="M5 5l6 6M11 5l-6 6" />
        </>
      );
      break;
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={cn('size-[15px] flex-none text-ink', className)}>
      {inner}
    </svg>
  );
}

type CheckLook = 'passed' | 'failed' | 'running' | 'quiet';

const LOOK: Record<GitHubCheckState | GitHubCheck['state'], CheckLook> = {
  success: 'passed',
  failure: 'failed',
  error: 'failed',
  'timed-out': 'failed',
  'action-required': 'failed',
  pending: 'running',
  expected: 'running',
  neutral: 'quiet',
  skipped: 'quiet',
  cancelled: 'quiet',
  stale: 'quiet',
};

export const CHECK_NAMES: Record<GitHubCheckState | GitHubCheck['state'], string> = {
  success: 'Passing',
  failure: 'Failing',
  error: 'Error',
  'timed-out': 'Timed out',
  'action-required': 'Action required',
  pending: 'Running',
  expected: 'Expected',
  neutral: 'Neutral',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  stale: 'Stale',
};

/** A check's (or the checks rollup's) state: a tick, a stamped "!", a dashed box, or a dash. */
export function CheckIcon({
  state,
  className,
}: {
  state: GitHubCheckState | GitHubCheck['state'];
  className?: string;
}) {
  const look = LOOK[state];
  return (
    <svg
      viewBox="0 0 16 16"
      role="img"
      aria-label={`Checks: ${CHECK_NAMES[state]}`}
      className={cn('size-[14px] flex-none text-ink', className)}
    >
      {look === 'passed' && (
        <>
          <rect className={box} x="1.75" y="1.75" width="12.5" height="12.5" />
          <path className="fill-none stroke-current [stroke-width:1.8]" d="M4.4 8.1l2.4 2.4 4.8-5" />
        </>
      )}
      {look === 'failed' && (
        <>
          <rect className="fill-current" x="1" y="1" width="14" height="14" />
          <path className="fill-none stroke-sheet [stroke-width:2]" d="M8 4v5M8 11v1.5" />
        </>
      )}
      {look === 'running' && (
        <>
          <rect className={dashed} x="1.75" y="1.75" width="12.5" height="12.5" />
          <rect className="fill-muted" x="6.5" y="6.5" width="3" height="3" />
        </>
      )}
      {look === 'quiet' && <path className="fill-none stroke-faint [stroke-width:1.5]" d="M3 8h10" />}
    </svg>
  );
}
