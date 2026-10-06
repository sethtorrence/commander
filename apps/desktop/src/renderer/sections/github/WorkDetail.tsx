import type { ActivityEntry, GitHubCheck, GitHubDiscussionEntry, GitHubIssueRef } from '@commander/domain';
import { cn, Kbd } from '@commander/ui';
import { type ReactNode, useRef } from 'react';
import { ItemWarning } from '../../links/ItemWarning';
import { usePeople } from '../../people/context';
import { shownAs } from '../../people/people';
import { ItemProject } from '../../projects/badges';
import { useProjects } from '../../projects/context';
import { describeIssueEntry } from '../linear/linear-issues';
import { Markdown } from '../linear/Markdown';
import { Eyebrow, PaneEmpty, PanePart } from '../todos/detail/parts';
import { TodoLinks } from '../todos/detail/TodoLinks';
import { whenShort } from '../todos/when';
import type { WorkLink } from './github-work';
import { CHECK_NAMES, CheckIcon, WorkStateIcon } from './glyphs';
import type { DiscussionState } from './use-github';
import { REVIEW_DECISIONS } from './WorkRow';
import {
  type GitHubIssue,
  identifierOf,
  isPullRequest,
  linkedWork,
  type PullRequest,
  reviewersOf,
  STATE_NAMES,
  stateOf,
  type Work,
} from './work';

/*
  The detail pane beside the list, after the Linear Section's: actions along the top (Open in
  GitHub, the Badge picker, Close), then the pull request's or issue's identifier and title, its
  fields, linked issues, checks, the body read-only, the discussion (fetched when the pane opens it),
  its Links both ways and its activity log. Everything from GitHub is other people's text: shown as
  text or through the read-only Markdown (no HTML, no images loaded), and only web addresses open, in
  the system browser. GitHub is read-only in v1, so nothing here edits it.
*/

const web = (href: string | null | undefined): href is string => !!href && /^https?:\/\//i.test(href.trim());

/** Opens a page on GitHub (or a check's page) in the system browser; plain text for anything else. */
function OutLink({
  href,
  className,
  children,
}: {
  href: string | null;
  className?: string;
  children: ReactNode;
}) {
  if (!web(href)) return <span className={className}>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children}
    </a>
  );
}

const none = <span className="font-medium text-faint">—</span>;
const linkClass = 'text-ink underline decoration-line underline-offset-2 hover:decoration-ink';

const REVIEW_WORDS = {
  approved: 'Approved',
  'changes-requested': 'Changes requested',
  commented: 'Commented',
  dismissed: 'Dismissed',
  pending: 'Pending',
} as const;

// A GitHub user as their Person: their name with every handle on hover ("You" for the User), or as
// `@login` while their Person goes by nothing more than the login; `@ghost` for a deleted user. The
// name opens the Person's page (#122).
function Login({ login }: { login: string | null }) {
  const people = usePeople();
  if (!login) return <>@ghost</>;
  const shown = shownAs(people, `github:${login}`, `@${login}`, { you: true });
  const named = shown.person && shown.person.name.toLowerCase() !== login.toLowerCase();
  const text = named || shown.person?.isUser ? shown.name : `@${login}`;
  const person = shown.person;
  const open = people.openPerson;
  if (!person || !open) return <span title={shown.title}>{text}</span>;
  return (
    <button
      type="button"
      data-person={person.id}
      title={`${shown.title} · Open their page`}
      onClick={() => open(person.id)}
      className="cursor-pointer border-0 bg-transparent p-0 text-inherit [font:inherit] [letter-spacing:inherit] [text-transform:inherit] hover:underline"
    >
      {text}
    </button>
  );
}

function Fact({ field, label, children }: { field: string; label: string; children: ReactNode }) {
  return (
    <div
      data-field={field}
      className="flex items-center justify-between gap-2.5 border-b border-line2 py-[7px] font-mono text-label-lg leading-[1.3] font-medium uppercase tracking-tag"
    >
      <dt className="flex-none text-muted">{label}</dt>
      <dd className="m-0 min-w-0 text-right font-semibold text-ink [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function Labels({ work }: { work: Work }) {
  if (!work.detail.labels.length) return none;
  return (
    <span className="flex flex-wrap justify-end gap-x-3 gap-y-1">
      {work.detail.labels.map((label) => (
        <span key={label.name} className="flex items-center gap-1.5">
          <i
            aria-hidden="true"
            className="inline-block size-2 border border-line"
            // GitHub's label colours are six hex digits; anything else isn't drawn.
            style={/^[0-9a-f]{6}$/i.test(label.color) ? { background: `#${label.color}` } : undefined}
          />
          {label.name}
        </span>
      ))}
    </span>
  );
}

function PullFacts({ pull }: { pull: PullRequest }) {
  const { detail } = pull;
  const reviewers = reviewersOf(pull);
  return (
    <>
      <Fact field="branches" label="Branches">
        <span className="normal-case tracking-normal">
          {detail.headBranch} → {detail.baseBranch}
        </span>
      </Fact>
      <Fact field="reviewers" label="Reviewers">
        {reviewers.length ? (
          <span className="flex flex-col items-end gap-1">
            {reviewers.map((reviewer) => (
              <span key={reviewer.name}>
                <span className="normal-case tracking-normal">
                  {reviewer.team ? reviewer.name : <Login login={reviewer.name} />}
                </span>{' '}
                <span className="font-medium text-muted">
                  · {reviewer.review ? REVIEW_WORDS[reviewer.review] : 'Asked'}
                </span>
              </span>
            ))}
          </span>
        ) : (
          none
        )}
      </Fact>
      <Fact field="review" label="Review">
        {detail.reviewDecision ? REVIEW_DECISIONS[detail.reviewDecision] : none}
      </Fact>
      <Fact field="size" label="Change size">
        <span className="tabular-nums">
          +{detail.additions} −{detail.deletions} · {detail.changedFiles}{' '}
          {detail.changedFiles === 1 ? 'file' : 'files'}
        </span>
      </Fact>
    </>
  );
}

function IssueFacts({ issue }: { issue: GitHubIssue }) {
  const { detail } = issue;
  return (
    <>
      <Fact field="milestone" label="Milestone">
        {detail.milestone ? (
          <span className="normal-case tracking-normal">{detail.milestone.title}</span>
        ) : (
          none
        )}
      </Fact>
      {detail.subIssues && (
        <Fact field="sub-issues" label="Sub-issues">
          {detail.subIssues.completed} of {detail.subIssues.total} done
        </Fact>
      )}
    </>
  );
}

/** The issues a pull request closes (or an issue's parent): in the Section when Commander holds them. */
function LinkedIssues({
  label,
  refs,
  all,
  onOpen,
}: {
  label: string;
  refs: GitHubIssueRef[];
  all: readonly Work[];
  onOpen: (itemId: string) => void;
}) {
  return (
    <PanePart label={label} count={refs.length}>
      {refs.length ? (
        refs.map((ref) => {
          const held = linkedWork(ref, all);
          const name = `${ref.owner}/${ref.name}#${ref.number}`;
          const row =
            'flex min-h-[34px] w-full items-center gap-2.5 border border-t-0 border-line bg-transparent px-2.5 py-1.5 text-left text-heading leading-[18px] text-text first-of-type:border-t';
          const inside = (
            <>
              <span className="flex-none font-mono text-label-lg text-muted">{name}</span>
              <span className="min-w-0 flex-1 truncate">{ref.title}</span>
            </>
          );
          return held ? (
            <button
              key={name}
              type="button"
              onClick={() => onOpen(held.id)}
              className={cn(row, 'cursor-pointer hover:bg-raise hover:text-ink')}
            >
              {inside}
            </button>
          ) : (
            <OutLink key={name} href={ref.url} className={cn(row, 'no-underline hover:bg-raise')}>
              {inside}
              <span aria-hidden="true">↗</span>
            </OutLink>
          );
        })
      ) : (
        <PaneEmpty>None.</PaneEmpty>
      )}
    </PanePart>
  );
}

function Checks({ pull, discussion }: { pull: PullRequest; discussion: DiscussionState | null }) {
  const checks: GitHubCheck[] | null =
    discussion?.status === 'ready' ? (discussion.discussion.checks ?? []) : null;
  const rollup = pull.detail.checks;
  return (
    <PanePart label="Checks" count={checks?.length ?? 0}>
      {checks === null ? (
        <p className="m-0 flex items-center gap-2 border border-line px-2.5 py-2 text-note text-muted">
          {rollup ? (
            <>
              <CheckIcon state={rollup} /> {CHECK_NAMES[rollup]}
            </>
          ) : (
            'No checks'
          )}
        </p>
      ) : checks.length ? (
        <ul className="m-0 list-none border border-line p-0">
          {checks.map((check, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: two checks may share a name
              key={index}
              data-testid="github-check"
              className="flex items-center gap-2.5 border-b border-line2 px-2.5 py-[7px] text-note last:border-b-0"
            >
              <CheckIcon state={check.state} />
              <OutLink
                href={check.url}
                className={cn('min-w-0 flex-1 truncate', web(check.url) && linkClass)}
              >
                {check.name}
              </OutLink>
              <span className="font-mono text-label-lg uppercase tracking-tag text-muted">
                {CHECK_NAMES[check.state]}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <PaneEmpty>No checks on the latest commit.</PaneEmpty>
      )}
    </PanePart>
  );
}

function EntryHead({ entry }: { entry: GitHubDiscussionEntry }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2.5">
      <span className="min-w-0 font-sans text-note text-ink">
        <b className="font-semibold">
          <Login login={entry.author} />
        </b>
        {entry.kind === 'review' && entry.state && (
          <span className="text-muted"> · {REVIEW_WORDS[entry.state]}</span>
        )}
        {entry.kind === 'review-comment' && entry.path && (
          <span className="ml-1.5 font-mono text-label-lg text-muted">
            {entry.path}
            {entry.line ? `:${entry.line}` : ''}
          </span>
        )}
      </span>
      <OutLink
        href={entry.url}
        className="flex-none font-mono text-label-lg whitespace-nowrap text-muted tabular-nums no-underline hover:text-ink"
      >
        <time dateTime={new Date(entry.at).toISOString()}>{whenShort(entry.at)}</time>
      </OutLink>
    </div>
  );
}

/** The discussion, fetched when the pane opens it: a thin line while it loads or when it couldn't. */
function Discussion({ work, discussion }: { work: Work; discussion: DiscussionState | null }) {
  const entries = discussion?.status === 'ready' ? discussion.discussion.entries : [];
  return (
    <PanePart label="Discussion" count={entries.length}>
      {discussion?.status === 'loading' && (
        <p role="status" data-testid="github-discussion-status" className="m-0 text-note text-muted">
          Loading discussion…
        </p>
      )}
      {discussion?.status === 'failed' && (
        <p
          role="alert"
          data-testid="github-discussion-status"
          className="m-0 border border-ink px-2.5 py-1.5 text-note text-text"
        >
          <b className="font-semibold text-ink">Couldn’t load the discussion</b>
          <span className="text-muted"> · {discussion.error}</span>
        </p>
      )}
      {discussion?.status === 'ready' && discussion.discussion.more && (
        <p className="m-0 mb-2 text-note text-muted">
          Showing the latest. Earlier ones are on{' '}
          <OutLink href={work.detail.url} className={linkClass}>
            GitHub ↗
          </OutLink>
          .
        </p>
      )}
      {discussion?.status === 'ready' &&
        (entries.length ? (
          <ol className="m-0 list-none border border-line p-0" data-testid="github-discussion">
            {entries.map((entry) => (
              <li key={entry.id} className="border-b border-line2 px-3.5 py-2.5 last:border-b-0">
                <EntryHead entry={entry} />
                {entry.body.trim() ? (
                  <Markdown source={entry.body} className="text-[14px]" />
                ) : (
                  <p className="m-0 text-note text-faint">No comment.</p>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <PaneEmpty>No discussion yet.</PaneEmpty>
        ))}
    </PanePart>
  );
}

export function WorkDetail({
  work,
  all,
  links,
  history,
  discussion,
  onFile,
  onClose,
  onOpenLink,
  onRemoveLink,
  onOpenWork,
}: {
  work: Work | null;
  /** Every pull request and issue Commander holds, for linked issues. */
  all: readonly Work[];
  links: WorkLink[];
  history: ActivityEntry[];
  discussion: DiscussionState | null;
  /** Opens the Badge picker for it. */
  onFile: () => void;
  onClose: () => void;
  onOpenLink: (link: WorkLink) => void;
  /** Removes one of its Links (a finishes Link GitHub made, which is then never made again). */
  onRemoveLink?: (link: WorkLink) => void;
  /** Opens another pull request or issue Commander holds in the Section. */
  onOpenWork: (itemId: string) => void;
}) {
  const { projects, archived } = useProjects();
  const pane = useRef<HTMLElement>(null);
  const pull = work && isPullRequest(work) ? work : null;
  const issue = work && !isPullRequest(work) ? work : null;
  const state = work ? stateOf(work) : null;
  return (
    <section
      ref={pane}
      tabIndex={-1}
      aria-label={pull ? 'Pull request detail' : 'Issue detail'}
      className="min-w-0 border-l border-line focus-visible:outline-none"
    >
      <div className="sticky top-(--body) max-h-[calc(100vh-var(--body))] overflow-auto [scrollbar-width:thin]">
        <div className="sticky top-0 z-2 flex h-11 items-stretch border-b border-line bg-sheet">
          {work && (
            <>
              <OutLink
                href={work.detail.url}
                className={cn(action, 'bg-ink text-sheet hover:bg-ink hover:opacity-90')}
              >
                Open in GitHub <span aria-hidden="true">↗</span>
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
        {work && state ? (
          <div className="px-[22px] pt-[18px] pb-24">
            <Eyebrow className="flex items-center gap-2">
              <WorkStateIcon state={state} issue={!pull} className="size-3" />
              <OutLink href={work.detail.url} className={linkClass}>
                {identifierOf(work)}
              </OutLink>
              · {STATE_NAMES[state]}
            </Eyebrow>
            <h2 className="mt-2 mb-1.5 font-sans text-[26px] leading-[1.15] font-bold tracking-[-0.015em] text-ink font-stretch-(--stretch-wide) [overflow-wrap:anywhere]">
              {work.title}
            </h2>
            <p className="m-0 font-sans text-[16px] leading-[1.3] font-light text-muted">
              Opened {whenShort(work.detail.createdAt)} by <Login login={work.detail.author} /> · updated{' '}
              {whenShort(work.detail.updatedAt)}
            </p>
            <ItemWarning item={work} variant="pane" className="mt-3" />
            <dl className="mt-3.5 mb-0 border-t border-line">
              <Fact field="repo" label="Repo">
                <span className="normal-case tracking-normal">
                  {work.detail.repo.owner}/{work.detail.repo.name}
                </span>
              </Fact>
              <Fact field="author" label="Author">
                <span className="normal-case tracking-normal">
                  <Login login={work.detail.author} />
                </span>
              </Fact>
              <Fact field="state" label="State">
                <span className="flex items-center justify-end gap-2">
                  <WorkStateIcon state={state} issue={!pull} />
                  {STATE_NAMES[state]}
                  {issue?.detail.stateReason === 'not-planned' && ' · not planned'}
                  {issue?.detail.stateReason === 'duplicate' && ' · duplicate'}
                </span>
              </Fact>
              <Fact field="labels" label="Labels">
                <Labels work={work} />
              </Fact>
              <Fact field="assignees" label="Assignees">
                {work.detail.assignees.length ? (
                  <span className="normal-case tracking-normal">
                    {work.detail.assignees.map((login, index) => (
                      <span key={login}>
                        {index > 0 && ', '}
                        <Login login={login} />
                      </span>
                    ))}
                  </span>
                ) : (
                  none
                )}
              </Fact>
              {pull && <PullFacts pull={pull} />}
              {issue && <IssueFacts issue={issue} />}
              <Fact field="project" label="Project">
                <ItemProject item={{ ...work, title: `${identifierOf(work)} ${work.title}` }} />
              </Fact>
            </dl>

            {pull && (
              <LinkedIssues
                label="Linked issues"
                refs={pull.detail.closingIssues}
                all={all}
                onOpen={onOpenWork}
              />
            )}
            {issue?.detail.parent && (
              <LinkedIssues label="Parent issue" refs={[issue.detail.parent]} all={all} onOpen={onOpenWork} />
            )}
            {pull && <Checks pull={pull} discussion={discussion} />}

            <section aria-label="Body" className="mt-[18px]">
              <Eyebrow className="mb-2 flex items-center justify-between">
                {pull ? 'Description' : 'Body'}
                <span className="font-medium text-faint normal-case tracking-normal">Read-only</span>
              </Eyebrow>
              {work.detail.body.trim() ? (
                <div className="border border-line px-3.5 py-3" data-testid="github-body">
                  <Markdown source={work.detail.body} />
                </div>
              ) : (
                <PaneEmpty>No description.</PaneEmpty>
              )}
            </section>

            <Discussion work={work} discussion={discussion} />

            <TodoLinks
              links={links}
              onOpen={onOpenLink}
              onRemove={onRemoveLink}
              removable={(link) => link.type === 'finishes' && !link.backlink}
            />

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
          <p className="m-0 px-[22px] py-[18px] text-note text-faint">Nothing selected.</p>
        )}
      </div>
    </section>
  );
}

const action =
  'flex cursor-pointer items-center gap-[9px] border-0 border-r border-line2 bg-transparent px-3.5 font-mono text-label-lg leading-none font-semibold uppercase tracking-label whitespace-nowrap text-ink no-underline hover:bg-raise [&_kbd]:h-[18px] [&_kbd]:text-label';
