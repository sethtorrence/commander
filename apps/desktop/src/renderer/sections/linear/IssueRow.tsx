import { cn } from '@commander/ui';
import { type ReactNode, useEffect, useRef } from 'react';
import { AskAres } from '../../links/AresButton';
import { ItemWarning } from '../../links/ItemWarning';
import { usePeople } from '../../people/context';
import { shownAs } from '../../people/people';
import { usePickBadge } from '../../projects/BadgePicker';
import { ItemBadge, useAccentBar } from '../../projects/badges';
import { PRIORITY_NAMES, PriorityIcon, StateIcon } from './glyphs';
import type { Issue } from './issues';

const pad = (n: number) => String(n).padStart(3, '0');

/** A small mono tag (.tg in the prototype): a state, an assignee, a workspace. */
export function Tag({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-5 max-w-[150px] flex-none items-center border border-line bg-sheet px-[7px] font-mono text-label leading-none font-medium uppercase tracking-label whitespace-nowrap text-muted [&>span]:truncate',
        className,
      )}
    >
      <span>{children}</span>
    </span>
  );
}

/**
 * The issue's Badge, in the row's Badge slot, with its Project's accent as the row's thin left bar.
 * Clicking it opens the Badge picker, as `b` does.
 */
export function IssueBadge({ issue }: { issue: Issue }) {
  const pick = usePickBadge();
  const bar = useAccentBar(issue.filing);
  const label = `${issue.detail.identifier} ${issue.title}`;
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
          data-item-id={issue.id}
          title="Change the Project (B)"
          aria-label={`Project of ${label}`}
          onClick={(event) => {
            event.stopPropagation();
            pick(
              { id: issue.id, title: label, filing: issue.filing, filingSuggestion: issue.filingSuggestion },
              event.currentTarget,
            );
          }}
          className="flex cursor-pointer border-0 bg-transparent p-0 hover:outline hover:outline-offset-1 hover:outline-ink focus-visible:outline focus-visible:outline-offset-1 focus-visible:outline-ink"
        >
          <ItemBadge filing={issue.filing} suggestion={issue.filingSuggestion} />
        </button>
      ) : (
        <ItemBadge filing={issue.filing} suggestion={issue.filingSuggestion} />
      )}
    </>
  );
}

/**
 * An issue's row: number, state mark, Badge, identifier and title, then its state, priority and
 * assignee, and its workspace when more than one is connected. A change made here that couldn't
 * reach Linear says so.
 */
export function IssueRow({
  issue,
  number,
  selected,
  mine,
  workspace,
  compact = false,
  unsynced = false,
  onOpen,
}: {
  issue: Issue;
  number: number;
  selected: boolean;
  /** Whether it is assigned to the User (shown as "You"). */
  mine: boolean;
  /** The workspace's name, when more than one is connected. */
  workspace: string | null;
  /** Beside the detail pane: the state and workspace tags make way for the title. */
  compact?: boolean;
  /** One of its changes made here couldn't sync to Linear. */
  unsynced?: boolean;
  /** Selects the row and opens it in the detail pane. */
  onOpen: () => void;
}) {
  const row = useRef<HTMLLIElement>(null);
  const { detail } = issue;
  const closed = issue.status === 'done';
  // The assignee as their Person, with their handles on hover; Linear's short name until known.
  const people = usePeople();
  const assignee = detail.assignee
    ? shownAs(people, `linear:${detail.assignee.id}`, detail.assignee.displayName)
    : null;
  const assigneeTitle = !detail.assignee
    ? 'Unassigned'
    : assignee?.person
      ? assignee.title
      : detail.assignee.name;
  const you = mine || !!assignee?.person?.isUser;
  useEffect(() => {
    if (selected) row.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  return (
    // Opening with the mouse; the keyboard moves the selection with j and k and opens with Enter.
    // biome-ignore lint/a11y/useKeyWithClickEvents: j/k and Enter work from the keyboard (LinearSheet's shortcuts)
    <li
      ref={row}
      aria-current={selected || undefined}
      aria-label={`${detail.identifier} ${issue.title}`}
      data-testid="linear-issue"
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
      <span className="grid h-7.5 w-6 flex-none place-items-center" title={detail.state.name}>
        <StateIcon type={detail.state.type} />
      </span>
      <span className="ml-1.5 flex h-7.5 w-[25px] flex-none items-center">
        <IssueBadge issue={issue} />
      </span>
      <span className="ml-3 flex-none font-mono text-code-lg leading-[30px] tracking-mono text-muted">
        {detail.identifier}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate pl-2.5 text-row leading-[30px]',
          closed ? 'text-faint line-through decoration-1' : 'text-text',
        )}
      >
        {issue.title}
      </span>
      <span className="mt-[5px] ml-3 flex flex-none items-center gap-1.5">
        <ItemWarning item={issue} />
        <AskAres item={issue} />
        {unsynced && (
          <Tag
            className="border-ink font-semibold text-ink"
            title="A change made here couldn’t sync to Linear"
          >
            Couldn’t sync
          </Tag>
        )}
        {!compact && <Tag>{detail.state.name}</Tag>}
        <span className="grid h-5 w-5 place-items-center" title={PRIORITY_NAMES[detail.priority]}>
          <PriorityIcon priority={detail.priority} />
        </span>
        <Tag className={cn(compact ? 'w-[72px]' : 'w-[92px]', you && 'text-ink')} title={assigneeTitle}>
          {you ? 'You' : (assignee?.name ?? '—')}
        </Tag>
        {workspace && !compact && <Tag className="border-dashed">{workspace}</Tag>}
      </span>
    </li>
  );
}
