import { cn } from '@commander/ui';
import { useEffect, useRef } from 'react';
import { AskAres } from '../../links/AresButton';
import { ItemWarning } from '../../links/ItemWarning';
import { usePeople } from '../../people/context';
import { shownAs } from '../../people/people';
import { usePickBadge } from '../../projects/BadgePicker';
import { ItemBadge, useAccentBar } from '../../projects/badges';
import { Tag } from '../linear/IssueRow';
import { CheckIcon, WorkStateIcon } from './glyphs';
import {
  ageOf,
  identifierOf,
  isPullRequest,
  type SkillProgress,
  STATE_NAMES,
  stateOf,
  type Work,
} from './work';

const pad = (n: number) => String(n).padStart(3, '0');

export const REVIEW_DECISIONS = {
  approved: 'Approved',
  'changes-requested': 'Changes requested',
  'review-required': 'Review required',
} as const;

/**
 * The row's Badge, in its Badge slot, with its Project's accent as the row's thin left bar. Clicking
 * it opens the Badge picker, as `b` does.
 */
function WorkBadge({ work }: { work: Work }) {
  const pick = usePickBadge();
  const bar = useAccentBar(work.filing);
  const label = `${identifierOf(work)} ${work.title}`;
  return (
    <>
      {bar && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-px bottom-0 left-[39px] w-0.5"
          style={{ background: bar }}
        />
      )}
      {pick ? (
        <button
          type="button"
          data-item-id={work.id}
          title="Change the Project (B)"
          aria-label={`Project of ${label}`}
          onClick={(event) => {
            event.stopPropagation();
            pick(
              { id: work.id, title: label, filing: work.filing, filingSuggestion: work.filingSuggestion },
              event.currentTarget,
            );
          }}
          className="flex cursor-pointer border-0 bg-transparent p-0 hover:outline hover:outline-offset-1 hover:outline-ink focus-visible:outline focus-visible:outline-offset-1 focus-visible:outline-ink"
        >
          <ItemBadge filing={work.filing} suggestion={work.filingSuggestion} />
        </button>
      ) : (
        <ItemBadge filing={work.filing} suggestion={work.filingSuggestion} />
      )}
    </>
  );
}

/**
 * A pull request's or issue's row, after the prototype's GitHub rows (.pr): number, state mark,
 * Badge, `owner/repo#123` and title, then its state, for a pull request the checks and the review
 * decision, its author and its age (since it was opened). A review asked of the User says so. A map's
 * row (#120) shows its progress instead of its age: it is open for months on purpose.
 */
export function WorkRow({
  work,
  number,
  selected,
  now,
  reviewAsked = false,
  note,
  progress,
  compact = false,
  onOpen,
}: {
  work: Work;
  number: number;
  selected: boolean;
  now: number;
  /** A review of it is asked of the User. */
  reviewAsked?: boolean;
  /** Your work's word on it: who the User's pull request waits on, or the team a review was asked of. */
  note?: string;
  /** A map's progress (#120), shown instead of its age. */
  progress?: SkillProgress;
  /** Beside the detail pane: the state and review tags make way for the title. */
  compact?: boolean;
  /** Selects the row and opens it in the detail pane. */
  onOpen: () => void;
}) {
  const row = useRef<HTMLLIElement>(null);
  const state = stateOf(work);
  const pull = isPullRequest(work) ? work : null;
  // The author as their Person, with their handles on hover; the login until Commander knows them.
  const people = usePeople();
  const author = work.detail.author
    ? shownAs(people, `github:${work.detail.author}`, work.detail.author)
    : null;
  const identifier = identifierOf(work);
  const closed = state === 'merged' || state === 'closed';
  useEffect(() => {
    if (selected) row.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  return (
    // Opening with the mouse; the keyboard moves the selection with j and k and opens with Enter.
    // biome-ignore lint/a11y/useKeyWithClickEvents: j/k and Enter work from the keyboard (GitHubSheet's shortcuts)
    <li
      ref={row}
      aria-current={selected || undefined}
      aria-label={`${identifier} ${work.title}`}
      data-testid="github-work"
      onClick={onOpen}
      className={cn(
        'relative flex min-h-10 cursor-default items-start border-b border-line2 py-[5px] pr-5 pl-13',
        selected
          ? 'bg-signal-focus shadow-[inset_3px_0_0_var(--signal)]'
          : 'hover:bg-[color-mix(in_srgb,var(--raise)_55%,transparent)]',
      )}
    >
      <span
        className={cn(
          'absolute top-[5px] left-0 w-10 text-center font-mono text-label leading-[30px]',
          selected ? 'font-semibold text-signal-ink' : 'font-medium text-faint',
        )}
      >
        {pad(number)}
      </span>
      <span className="grid h-7.5 w-6 flex-none place-items-center" title={STATE_NAMES[state]}>
        <WorkStateIcon state={state} issue={!pull} />
      </span>
      <span className="ml-1.5 flex h-7.5 w-[25px] flex-none items-center">
        <WorkBadge work={work} />
      </span>
      <span className="ml-3 max-w-[260px] flex-none truncate font-mono text-code-lg leading-[30px] tracking-mono text-muted">
        {identifier}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate pl-2.5 text-row leading-[30px]',
          closed ? 'text-faint line-through decoration-1' : 'text-text',
        )}
      >
        {work.title}
      </span>
      <span className="mt-[5px] ml-3 flex flex-none items-center gap-1.5">
        <ItemWarning item={work} />
        <AskAres item={work} />
        {reviewAsked && (
          <Tag className="border-ink font-semibold text-ink" title="Your review is asked for">
            Your review
          </Tag>
        )}
        {note && (
          <Tag className="max-w-[220px] truncate font-semibold text-ink" title={note}>
            {note}
          </Tag>
        )}
        {!compact && <Tag>{STATE_NAMES[state]}</Tag>}
        {pull && (
          <span className="grid h-5 w-5 place-items-center">
            {pull.detail.checks ? <CheckIcon state={pull.detail.checks} /> : null}
          </span>
        )}
        {pull?.detail.reviewDecision && !compact && <Tag>{REVIEW_DECISIONS[pull.detail.reviewDecision]}</Tag>}
        <Tag className={compact ? 'w-[72px]' : 'w-[92px]'} title={author?.title ?? 'A deleted user'}>
          {author?.name ?? 'ghost'}
        </Tag>
        {progress ? (
          <span
            className="min-w-8 text-right font-mono text-label leading-5 font-medium tabular-nums text-muted"
            title={progress.line}
          >
            {progress.done}/{progress.total}
          </span>
        ) : (
          <span
            className="w-8 text-right font-mono text-label leading-5 font-medium tabular-nums text-muted"
            title="Open for"
          >
            {ageOf(work.detail.createdAt, now)}
          </span>
        )}
      </span>
    </li>
  );
}
