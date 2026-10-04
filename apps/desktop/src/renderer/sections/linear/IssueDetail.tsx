import type { ActivityEntry, LinearIssueDetail } from '@commander/domain';
import { cn, Kbd } from '@commander/ui';
import { type ReactNode, useRef } from 'react';
import { shortDate } from '../../frame/calendar';
import { ItemBadge } from '../../projects/badges';
import { useProjects } from '../../projects/context';
import { Eyebrow, PaneEmpty, PanePart } from '../todos/detail/parts';
import { TodoLinks } from '../todos/detail/TodoLinks';
import { whenShort } from '../todos/when';
import type { IssueSync, PickerOptions } from './editing';
import {
  AssigneePicker,
  CommentBox,
  CyclePicker,
  cycleName,
  DueDateInput,
  EstimateInput,
  type FieldEdit,
  LabelsPicker,
  LinearProjectPicker,
  PriorityPicker,
  StatePicker,
} from './FieldEditors';
import { PRIORITY_NAMES, PriorityIcon, StateIcon } from './glyphs';
import type { Issue } from './issues';
import { describeIssueEntry, type IssueLink } from './linear-issues';
import { Markdown } from './Markdown';

/*
  The detail pane beside the list, after the Todos detail pane and the prototype's reader: actions
  along the top, then the issue's identifier (a link to it in Linear), title, fields, description,
  comments, Links both ways and activity log.

  Two-way sync: the fields marked `writable` below are edited in place (pickers, and inputs for the
  due date and estimate), and a comment box sits under the comments. Edits show at once; a line
  under the fields says when they are on their way to Linear, or couldn't sync (with Retry), and
  notes a change made in Linear that won over the User's. The description stays read-only, with
  Edit in Linear.
*/

type FieldKey =
  | 'state'
  | 'priority'
  | 'assignee'
  | 'team'
  | 'linearProject'
  | 'cycle'
  | 'labels'
  | 'dueDate'
  | 'estimate';

// The issue's fields, in order. `writable`: changeable from Commander (#14).
const FIELDS: { key: FieldKey; label: string; writable: boolean }[] = [
  { key: 'state', label: 'State', writable: true },
  { key: 'priority', label: 'Priority', writable: true },
  { key: 'assignee', label: 'Assignee', writable: true },
  { key: 'team', label: 'Team', writable: false },
  { key: 'linearProject', label: 'Linear project', writable: true },
  { key: 'cycle', label: 'Cycle', writable: true },
  { key: 'labels', label: 'Labels', writable: true },
  { key: 'dueDate', label: 'Due', writable: true },
  { key: 'estimate', label: 'Estimate', writable: true },
];

const none = <span className="font-medium text-faint">—</span>;

function dueDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return shortDate(new Date(y ?? 0, (m ?? 1) - 1, d ?? 1));
}

function fieldValue(key: FieldKey, detail: LinearIssueDetail, mine: boolean): ReactNode {
  switch (key) {
    case 'state':
      return (
        <span className="flex items-center justify-end gap-2">
          <StateIcon type={detail.state.type} />
          {detail.state.name}
        </span>
      );
    case 'priority':
      return (
        <span className="flex items-center justify-end gap-2">
          <PriorityIcon priority={detail.priority} />
          {PRIORITY_NAMES[detail.priority] ?? PRIORITY_NAMES[0]}
        </span>
      );
    case 'assignee':
      if (!detail.assignee) return none;
      return mine ? `You (${detail.assignee.name})` : detail.assignee.name;
    case 'team':
      return `${detail.team.name} (${detail.team.key})`;
    case 'linearProject':
      return detail.linearProject?.name ?? none;
    case 'cycle':
      if (!detail.cycle) return none;
      return cycleName(detail.cycle);
    case 'labels':
      if (!detail.labels.length) return none;
      return (
        <span className="flex flex-wrap justify-end gap-x-3 gap-y-1">
          {detail.labels.map((label) => (
            <span key={label.id} className="flex items-center gap-1.5">
              <i
                aria-hidden="true"
                className="inline-block size-2 border border-line"
                style={{ background: label.color }}
              />
              {label.name}
            </span>
          ))}
        </span>
      );
    case 'dueDate':
      return detail.dueDate ? dueDate(detail.dueDate) : none;
    case 'estimate':
      return detail.estimate === null
        ? none
        : `${detail.estimate} ${detail.estimate === 1 ? 'point' : 'points'}`;
  }
}

/** A writable field's editor, showing its value as the read-only pane does. */
function editorFor(
  key: FieldKey,
  detail: LinearIssueDetail,
  shown: ReactNode,
  editing: Editing,
  afterChoice: () => void,
): ReactNode {
  const props = { detail, options: editing.options, onEdit: editing.onEdit, display: shown, afterChoice };
  switch (key) {
    case 'state':
      return <StatePicker {...props} />;
    case 'priority':
      return <PriorityPicker {...props} />;
    case 'assignee':
      return <AssigneePicker {...props} me={editing.me} />;
    case 'linearProject':
      return <LinearProjectPicker {...props} />;
    case 'cycle':
      return <CyclePicker {...props} />;
    case 'labels':
      return <LabelsPicker {...props} />;
    case 'dueDate':
      return <DueDateInput detail={detail} onEdit={editing.onEdit} />;
    case 'estimate':
      return <EstimateInput detail={detail} onEdit={editing.onEdit} />;
    default:
      return shown;
  }
}

/** What the pane needs to edit the issue (Two-way sync). */
export interface Editing {
  options: PickerOptions;
  /** The User's own Linear user id in the issue's workspace. */
  me: string | null;
  /** Where the issue's changes stand. */
  sync: IssueSync;
  /** Why changes on their way can't go yet (offline, needs reconnecting), when they can't. */
  waiting: string | null;
  /** A change made in Linear that won over the User's, as its note. */
  note: string | null;
  onEdit: FieldEdit;
  onComment: (body: string) => Promise<boolean>;
  onRetry: () => void;
}

/** The line under the fields: changes on their way, Couldn't sync with Retry, or Linear's note. */
function SyncLine({ editing }: { editing: Editing }) {
  const { sync, note, waiting, onRetry } = editing;
  if (sync.kind === 'failed') {
    return (
      <div
        role="alert"
        data-testid="issue-sync"
        className="mt-2.5 flex items-center justify-between gap-2.5 border border-ink px-2.5 py-1.5 text-note"
      >
        <span>
          <b className="font-semibold text-ink">Couldn’t sync</b>
          {sync.error && <span className="text-muted"> · {sync.error}</span>}
        </span>
        <button
          type="button"
          onClick={onRetry}
          className="cursor-pointer border border-ink bg-transparent px-2.5 py-0.5 font-mono text-label-lg font-semibold uppercase tracking-label text-ink hover:bg-raise"
        >
          Retry
        </button>
      </div>
    );
  }
  if (sync.kind === 'sending') {
    return (
      <p role="status" data-testid="issue-sync" className="m-0 mt-2.5 text-note text-muted">
        {waiting ?? 'Saving to Linear…'}
      </p>
    );
  }
  if (note) {
    return (
      <p
        role="status"
        data-testid="issue-sync"
        className="m-0 mt-2.5 border border-line px-2.5 py-1.5 text-note text-text"
      >
        {note}
      </p>
    );
  }
  return null;
}

/** Opens the issue (or anything on Linear) in the system browser, through the window's new-window handler. */
function OutLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children}
    </a>
  );
}

export function IssueDetail({
  issue,
  mine,
  workspace,
  links,
  history,
  editing,
  onFile,
  onClose,
  onOpenLink,
}: {
  issue: Issue | null;
  mine: boolean;
  /** The workspace's name. */
  workspace: string | null;
  links: IssueLink[];
  history: ActivityEntry[];
  /** Editing the issue's synced fields and commenting; without it the pane is read-only. */
  editing?: Editing;
  /** Opens the Badge picker for the issue. */
  onFile: () => void;
  onClose: () => void;
  onOpenLink: (link: IssueLink) => void;
}) {
  const { projects, archived, projectOf } = useProjects();
  const detail = issue?.detail;
  const project = issue ? projectOf(issue.filing) : undefined;
  const pane = useRef<HTMLElement>(null);
  const backToPane = () => pane.current?.focus();
  return (
    <section
      ref={pane}
      tabIndex={-1}
      aria-label="Issue detail"
      className="min-w-0 border-l border-line focus-visible:outline-none"
    >
      <div className="sticky top-(--body) max-h-[calc(100vh-var(--body))] overflow-auto [scrollbar-width:thin]">
        <div className="sticky top-0 z-2 flex h-11 items-stretch border-b border-line bg-sheet">
          {issue && detail && (
            <>
              <OutLink
                href={detail.url}
                className={cn(action, 'bg-ink text-sheet hover:bg-ink hover:opacity-90')}
              >
                Open in Linear <span aria-hidden="true">↗</span>
              </OutLink>
              <button type="button" onClick={onFile} className={action}>
                <Kbd>B</Kbd>
                Project
              </button>
            </>
          )}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className={cn(action, 'border-r-0 border-l')}>
            <Kbd>Esc</Kbd>
            Close
          </button>
        </div>
        {issue && detail ? (
          <div className="px-[22px] pt-[18px] pb-24">
            <Eyebrow>
              <OutLink
                href={detail.url}
                className="text-ink underline decoration-line underline-offset-2 hover:decoration-ink"
              >
                {detail.identifier}
              </OutLink>
              {workspace && ` · ${workspace}`} · {issue.status === 'done' ? 'Closed' : 'Open'}
            </Eyebrow>
            <h2 className="mt-2 mb-1.5 font-sans text-[26px] leading-[1.15] font-bold tracking-[-0.015em] text-ink font-stretch-(--stretch-wide) [overflow-wrap:anywhere]">
              {issue.title}
            </h2>
            <p className="m-0 font-sans text-[16px] leading-[1.3] font-light text-muted">
              Opened {whenShort(detail.createdAt)}
              {detail.creator && ` by ${detail.creator.name}`} · updated {whenShort(detail.updatedAt)}
            </p>
            <dl className="mt-3.5 mb-0 border-t border-line">
              {FIELDS.map((field) => {
                const shown = fieldValue(field.key, detail, mine);
                return (
                  <Fact key={field.key} field={field.key} label={field.label}>
                    {editing && field.writable
                      ? editorFor(field.key, detail, shown, editing, backToPane)
                      : shown}
                  </Fact>
                );
              })}
              <Fact field="project" label="Project">
                <span className="flex items-center justify-end gap-[9px]">
                  <ItemBadge filing={issue.filing} />
                  {project ? project.name : 'Unfiled'}
                </span>
              </Fact>
            </dl>
            {editing && <SyncLine editing={editing} />}

            <section aria-label="Description" className="mt-[18px]">
              <Eyebrow className="mb-2 flex items-center justify-between">
                Description
                <OutLink
                  href={detail.url}
                  className="font-semibold text-ink underline decoration-line underline-offset-2 hover:decoration-ink"
                >
                  Edit in Linear ↗
                </OutLink>
              </Eyebrow>
              {detail.description?.trim() ? (
                <div className="border border-line px-3.5 py-3">
                  <Markdown source={detail.description} />
                </div>
              ) : (
                <PaneEmpty>No description.</PaneEmpty>
              )}
            </section>

            <PanePart label="Comments" count={detail.comments.length}>
              {detail.comments.length ? (
                <ol className="m-0 list-none border border-line p-0">
                  {detail.comments.map((comment) => (
                    <li key={comment.id} className="border-b border-line2 px-3.5 py-2.5 last:border-b-0">
                      <div className="mb-1.5 flex items-baseline justify-between gap-2.5">
                        <span className="font-sans text-note font-semibold text-ink">
                          {comment.author?.name ?? 'Linear'}
                        </span>
                        <time
                          dateTime={new Date(comment.createdAt).toISOString()}
                          className="font-mono text-label-lg whitespace-nowrap text-muted tabular-nums"
                        >
                          {whenShort(comment.createdAt)}
                        </time>
                      </div>
                      <Markdown source={comment.body} className="text-[14px]" />
                    </li>
                  ))}
                </ol>
              ) : (
                <PaneEmpty>No comments.</PaneEmpty>
              )}
              {editing && <CommentBox onComment={editing.onComment} />}
            </PanePart>

            <TodoLinks links={links} onOpen={onOpenLink} />

            <PanePart label="Activity" count={history.length}>
              <ol className="m-0 list-none border border-line p-0">
                {history.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex justify-between gap-2.5 border-b border-line2 px-2.5 py-[7px] text-note leading-[18px] last:border-b-0"
                  >
                    <span className="text-text">
                      {describeIssueEntry(entry, history, [...projects, ...archived])}
                    </span>
                    <time
                      dateTime={new Date(entry.at).toISOString()}
                      className="font-mono text-label-lg leading-[18px] whitespace-nowrap text-muted tabular-nums"
                    >
                      {whenShort(entry.at)}
                    </time>
                  </li>
                ))}
              </ol>
            </PanePart>
          </div>
        ) : (
          <p className="m-0 px-[22px] py-[18px] text-note text-faint">No issue selected.</p>
        )}
      </div>
    </section>
  );
}

const action =
  'flex cursor-pointer items-center gap-[9px] border-0 border-r border-line2 bg-transparent px-3.5 font-mono text-label-lg leading-none font-semibold uppercase tracking-label whitespace-nowrap text-ink no-underline hover:bg-raise [&_kbd]:h-[18px] [&_kbd]:text-label';

function Fact({ field, label, children }: { field: string; label: string; children: ReactNode }) {
  return (
    <div
      data-field={field}
      className="flex items-center justify-between gap-2.5 border-b border-line2 py-[7px] font-mono text-label-lg leading-[1.3] font-medium uppercase tracking-tag"
    >
      <dt className="flex-none text-muted">{label}</dt>
      <dd className="m-0 min-w-0 text-right font-semibold text-ink">{children}</dd>
    </div>
  );
}
