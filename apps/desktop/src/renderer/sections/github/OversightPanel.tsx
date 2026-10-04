import {
  type GitHubRepoName,
  type GitHubSummaryEntry,
  type GitHubSummaryItem,
  isGitHubSummary,
  localDay,
  OVERSIGHT_SECTION_TITLES,
  type OversightRangeChoice,
  type OversightSummary,
  type PlainLine,
  type PlainSummary,
  plainSummary,
  type SummaryWriterState,
  summaryRangeLabel,
  writerProblem,
} from '@commander/domain';
import {
  AresText,
  ChevronIcon,
  cn,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@commander/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ItemChanges } from '../../item-store/changes';
import { useProjects } from '../../projects/context';
import { useSection } from '../section';
import type { GitHubAccountsClient } from './github-work';
import {
  localTimeZone,
  type OversightClient,
  type OversightScope,
  scopeOf,
  spanOf,
  summaryFor,
} from './oversight';
import { ProgressBar } from './ProgressGroup';

export const SUMMARY_OPEN_KEY = 'commander.github.summary.open';

const RANGES: { kind: OversightRangeChoice['kind']; label: string }[] = [
  { kind: 'since-yesterday', label: 'Since yesterday' },
  { kind: 'this-week', label: 'This week' },
  { kind: 'since', label: 'Custom since…' },
];

const NOTHING: Record<string, string> = {
  shipped: 'Nothing shipped.',
  started: 'Nothing started.',
  stuck: 'Nothing stuck.',
};

const pad = (n: number) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const clock = (at: number) => `${pad(new Date(at).getHours())}:${pad(new Date(at).getMinutes())}`;
// "07:02" today, else "Mon 5 Oct 07:02".
const whenWritten = (at: number, now: number) => {
  if (localDay(at) === localDay(now)) return clock(at);
  const date = new Date(at);
  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${clock(at)}`;
};

// "2026-10-01": a week before today, the custom range's first suggestion.
function aWeekAgo(now: number): string {
  const day = new Date(now - 7 * 24 * 3_600_000);
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/** What a line or an entry opens: its Items, else its repo. */
export type SummaryTarget = Pick<PlainLine, 'itemIds' | 'repo' | 'text'>;

/**
 * The oversight summary at the top of the GitHub Section, in a collapsible panel, with a range picker
 * (Since yesterday, This week, Custom since…) and a Project picker.
 *
 * Ares's summary (#121) when he has written one for what the pickers show today (the daily summary
 * for since yesterday over everything, or one asked for with **Ask Ares to write it**), drawn with
 * AresText: "Written by Ares 07:02 · since yesterday", then each section, Project and repo, each entry
 * opening its Items. **Past summaries** reopens any he wrote. Showing one marks it seen.
 *
 * Otherwise the plain summary of the facts (#119): what Shipped, Started, is Stuck and is On fire, per
 * Project then repo, ending "Nothing on fire"; maps and milestones that moved under Progress, each
 * with a thin bar (#120). With the model off, failing or over the cap, it says so above them.
 *
 * It is read again when Items change or a sync finishes.
 */
export function OversightPanel({
  client,
  accounts,
  changes,
  onOpen,
  revealed,
  sourcesOf,
  storage = window.localStorage,
  now = Date.now,
}: {
  client: OversightClient;
  accounts?: GitHubAccountsClient;
  changes?: ItemChanges;
  onOpen: (target: SummaryTarget) => void;
  /** One of Ares's summaries to show (the Dashboard's row, the Update's Open), each time it changes. */
  revealed?: { summary: GitHubSummaryItem; n: number } | null;
  /** What an entry's text may link to (AresText): what its Items say. */
  sourcesOf?: (itemIds: readonly string[]) => string[];
  storage?: Storage;
  now?: () => number;
}) {
  const { projects } = useProjects();
  const { active } = useSection();
  const [open, setOpenState] = useState(() => {
    try {
      return storage.getItem(SUMMARY_OPEN_KEY) !== 'false';
    } catch {
      return true;
    }
  });
  const [range, setRangeState] = useState<OversightRangeChoice['kind']>('since-yesterday');
  const [since, setSinceState] = useState(() => aWeekAgo(now()));
  const [scope, setScopeState] = useState<OversightScope>('everything');
  const [summary, setSummary] = useState<OversightSummary | null>(null);
  const [written, setWritten] = useState<GitHubSummaryItem[]>([]);
  const [writer, setWriter] = useState<SummaryWriterState | null>(null);
  // One of Ares's summaries shown whatever the pickers say (Past summaries, the Dashboard's row).
  const [pinned, setPinned] = useState<GitHubSummaryItem | null>(null);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  const setOpen = (next: boolean) => {
    setOpenState(next);
    try {
      storage.setItem(SUMMARY_OPEN_KEY, String(next));
    } catch {
      // Storage unavailable: it applies for this session.
    }
  };
  // Choosing another range or scope shows what the pickers say again.
  const unpin = () => {
    setPinned(null);
    setProblem(null);
  };
  const setRange = (next: OversightRangeChoice['kind']) => {
    setRangeState(next);
    unpin();
  };
  const setSince = (next: string) => {
    setSinceState(next);
    unpin();
  };
  const setScope = (next: OversightScope) => {
    setScopeState(next);
    unpin();
  };

  const choice: OversightRangeChoice | null = useMemo(() => {
    if (range !== 'since') return { kind: range };
    return /^\d{4}-\d{2}-\d{2}$/.test(since) ? { kind: 'since', day: since } : null;
  }, [range, since]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload
  useEffect(() => {
    if (!choice || !open) return;
    let current = true;
    client.summary(spanOf(choice, now()), scope).then(
      (next) => current && setSummary(next),
      (error: unknown) => toast(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      current = false;
    };
  }, [client, choice, scope, open, version, now]);

  // Ares's summaries, and how his writing stands.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload
  useEffect(() => {
    if (!open || !client.summaries) return;
    let current = true;
    client.summaries().then(
      (next) => {
        if (!current) return;
        setWritten(next.summaries.filter(isGitHubSummary));
        setWriter(next.writer);
      },
      (error: unknown) => toast(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      current = false;
    };
  }, [client, open, version]);

  // A summary asked for elsewhere (the Dashboard's row, the Update's Open): shown, the panel open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request shows it
  useEffect(() => {
    if (!revealed) return;
    setPinned(revealed.summary);
    setProblem(null);
    setHistoryOpen(false);
    if (!open) setOpen(true);
    reload();
  }, [revealed]);

  // Read again when Items change (a sync, filing, a summary written) or a sync finishes (repo
  // health), and on coming back to the Section, a little after the last word.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(reload, 300);
  }, [reload]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useEffect(() => changes?.(() => soon()), [changes, soon]);
  useEffect(() => accounts?.onChange(() => soon()), [accounts, soon]);
  useEffect(() => {
    if (active) reload();
  }, [active, reload]);

  const shown = useMemo(() => {
    if (pinned) return written.find((each) => each.id === pinned.id) ?? pinned;
    return choice ? summaryFor(written, choice, scope, now()) : null;
  }, [pinned, written, choice, scope, now]);

  // Showing one of Ares's summaries, open in the Section in view, is opening it: seen.
  const marked = useRef(new Set<string>());
  useEffect(() => {
    if (!shown || !open || !active || shown.detail.seenAt !== null || marked.current.has(shown.id)) return;
    marked.current.add(shown.id);
    void client.seen?.(shown.id).catch(() => marked.current.delete(shown.id));
  }, [client, shown, open, active]);

  const plain: PlainSummary | null = useMemo(() => (summary ? plainSummary(summary) : null), [summary]);
  const shownProject = projects.find((project) => project.id === scope);
  const note = shown ? null : (problem ?? (writer ? writerProblem(writer) : null));

  const ask = () => {
    if (!client.ask || !choice || asking) return;
    if (!open) setOpen(true);
    setAsking(true);
    setProblem(null);
    client.ask(spanOf(choice, now()), scope, choice).then(
      (answer) => {
        setAsking(false);
        if (isGitHubSummary(answer.summary)) setPinned(answer.summary);
        else setProblem(answer.problem ?? 'Ares couldn’t write the summary just now.');
        reload();
      },
      (error: unknown) => {
        setAsking(false);
        setProblem(error instanceof Error ? error.message : String(error));
      },
    );
  };

  const headerButton =
    'cursor-pointer border-0 border-l border-line2 bg-transparent px-3 font-mono text-label leading-none uppercase tracking-label whitespace-nowrap';

  return (
    <section
      aria-label="Oversight summary"
      data-testid="github-summary"
      className="flex-none border-b border-line bg-sheet"
    >
      <div className="flex h-10 items-stretch border-b border-line2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex cursor-pointer items-center gap-2.5 border-0 border-r border-line2 bg-transparent pr-4 pl-[41px] font-sans text-[12px] leading-none font-bold uppercase tracking-heading text-ink font-stretch-(--stretch-wider) hover:bg-raise"
        >
          Summary
          <ChevronIcon className={cn('text-muted transition-transform', !open && '-rotate-90')} />
        </button>
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and form semantics */}
        <div role="group" aria-label="Summary range" className="flex items-stretch">
          {RANGES.map(({ kind, label }) => (
            <button
              key={kind}
              type="button"
              aria-pressed={range === kind}
              onClick={() => {
                setRange(kind);
                if (!open) setOpen(true);
              }}
              className={cn(
                'cursor-pointer border-0 border-r border-line2 bg-transparent px-3 font-mono text-label leading-none uppercase tracking-label whitespace-nowrap',
                range === kind ? 'bg-raise font-semibold text-ink' : 'font-medium text-muted hover:bg-raise',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {range === 'since' && (
          <Input
            type="date"
            aria-label="Summary since"
            value={since}
            onChange={(change) => setSince(change.target.value)}
            className="h-full w-[150px] rounded-none border-0 border-r border-line2"
          />
        )}
        <span className="flex-1" />
        {client.ask && (
          <button
            type="button"
            data-testid="github-summary-ask"
            disabled={!choice || asking}
            onClick={ask}
            className={cn(
              headerButton,
              'font-medium text-ink hover:bg-raise disabled:cursor-default disabled:text-faint',
            )}
          >
            {asking ? 'Ares is writing…' : 'Ask Ares to write it'}
          </button>
        )}
        {written.length > 0 && (
          <button
            type="button"
            aria-expanded={historyOpen}
            onClick={() => {
              setHistoryOpen(!historyOpen);
              if (!open) setOpen(true);
            }}
            className={cn(
              headerButton,
              historyOpen ? 'bg-raise font-semibold text-ink' : 'font-medium text-muted hover:bg-raise',
            )}
          >
            Past summaries
          </button>
        )}
        <Select value={scope} onValueChange={setScope}>
          <SelectTrigger
            aria-label="Summary Project"
            className="h-full w-auto max-w-[240px] gap-2 border-0 border-l border-line2 px-3 hover:bg-raise"
          >
            <SelectValue>
              <span className="font-medium text-faint">Project</span>{' '}
              <span className="text-ink">
                {scope === 'everything'
                  ? 'Everything'
                  : scope === 'unfiled'
                    ? 'Unfiled'
                    : (shownProject?.name ?? '—')}
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="everything">Everything</SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
            <SelectItem value="unfiled">Unfiled</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {open && historyOpen && (
        <PastSummaries
          summaries={written}
          shown={shown?.id ?? null}
          now={now()}
          onPick={(picked) => {
            setPinned(picked);
            setProblem(null);
            setHistoryOpen(false);
          }}
        />
      )}
      {open && (
        <div className="max-h-[320px] overflow-auto py-2 pr-5 pl-[41px] [scrollbar-width:thin]">
          {shown ? (
            <AresSummary
              summary={shown}
              projectName={(id) => projects.find((project) => project.id === id)?.name ?? null}
              now={now()}
              pinned={pinned !== null}
              onLatest={unpin}
              onOpen={onOpen}
              sourcesOf={sourcesOf}
            />
          ) : (
            <>
              {note && (
                <p data-testid="github-summary-note" className="m-0 pb-1 text-note leading-5 text-muted">
                  {note} These are the plain facts.
                </p>
              )}
              <PlainBody plain={plain} choice={choice} onOpen={onOpen} />
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** The plain summary of the facts (#119), line by line. */
function PlainBody({
  plain,
  choice,
  onOpen,
}: {
  plain: PlainSummary | null;
  choice: OversightRangeChoice | null;
  onOpen: (target: SummaryTarget) => void;
}) {
  if (!plain)
    return (
      <p className="m-0 py-1 text-note text-faint">{choice ? 'Reading…' : 'Choose a day to start from.'}</p>
    );
  return (
    <>
      {plain.sections.map((section) =>
        (section.kind === 'on-fire' || section.kind === 'progress') && !section.groups.length ? null : (
          <section key={section.kind} aria-label={section.title} className="py-1">
            <SectionTitle>{section.title}</SectionTitle>
            {section.groups.length ? (
              section.groups.map((group) => (
                <div key={group.project?.id ?? 'unfiled'} className="pl-3">
                  <p className="m-0 text-note leading-5 font-semibold text-text">{group.title}</p>
                  <ul className="m-0 list-none p-0 pl-3">
                    {group.lines.map((line) => (
                      <li key={`${line.text}:${line.itemIds.join(',')}`} className="flex items-center gap-3">
                        <button
                          type="button"
                          data-testid="github-summary-line"
                          onClick={() => onOpen(line)}
                          className="cursor-pointer border-0 bg-transparent p-0 text-left text-note leading-5 text-text hover:text-ink hover:underline"
                        >
                          {line.text}
                        </button>
                        {line.progress && (
                          <ProgressBar
                            done={line.progress.done}
                            total={line.progress.total}
                            label={`${line.text.slice(0, line.text.indexOf(': '))} progress`}
                            className="w-20 flex-none"
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            ) : (
              <p className="m-0 pl-3 text-note leading-5 text-faint">{NOTHING[section.kind]}</p>
            )}
          </section>
        ),
      )}
      {plain.closing && <Closing>{plain.closing}</Closing>}
    </>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <h3 className="m-0 font-mono text-label leading-6 font-semibold uppercase tracking-label text-muted">
      {children}
    </h3>
  );
}

function Closing({ children }: { children: string }) {
  return (
    <p data-testid="github-summary-closing" className="m-0 py-1 text-note leading-5 font-semibold text-text">
      {children}
    </p>
  );
}

const fullName = (repo: Pick<GitHubRepoName, 'owner' | 'name'>) => `${repo.owner}/${repo.name}`;

/** Ares's summary (#121): who wrote it and when, then his entries, each opening its Items. */
function AresSummary({
  summary,
  projectName,
  now,
  pinned,
  onLatest,
  onOpen,
  sourcesOf,
}: {
  summary: GitHubSummaryItem;
  projectName: (id: string) => string | null;
  now: number;
  pinned: boolean;
  onLatest: () => void;
  onOpen: (target: SummaryTarget) => void;
  sourcesOf?: (itemIds: readonly string[]) => string[];
}) {
  const { detail } = summary;
  const scope = scopeOf(summary);
  const scopeName = scope === 'everything' ? null : scope === 'unfiled' ? 'Unfiled' : projectName(scope);
  const by = [
    `Written by Ares ${whenWritten(detail.writtenAt, now)}`,
    ...(detail.cadence === 'weekly' ? ['roll-up'] : []),
    ...(scopeName ? [scopeName] : []),
    summaryRangeLabel(detail, localTimeZone()),
  ].join(' · ');
  return (
    <div data-testid="github-ares-summary">
      <p className="m-0 flex items-center gap-3 pb-1 text-note leading-5 text-muted">
        <span data-testid="github-summary-by">{by}</span>
        {pinned && (
          <button
            type="button"
            onClick={onLatest}
            className="cursor-pointer border-0 bg-transparent p-0 font-mono text-label leading-none font-medium uppercase tracking-label text-muted hover:text-ink"
          >
            Back to the pickers
          </button>
        )}
      </p>
      {detail.sections.length === 0 && (
        <p className="m-0 py-1 text-note leading-5 text-faint">Ares found nothing worth telling.</p>
      )}
      {detail.sections.map((section) => (
        <section key={section.kind} aria-label={OVERSIGHT_SECTION_TITLES[section.kind]} className="py-1">
          <SectionTitle>{OVERSIGHT_SECTION_TITLES[section.kind]}</SectionTitle>
          {section.groups.map((group) => (
            <div key={group.project?.id ?? 'unfiled'} className="pl-3">
              <p className="m-0 text-note leading-5 font-semibold text-text">
                {group.project?.name ?? 'Unfiled'}
              </p>
              {group.repos.map(({ repo, entries }) => (
                <div key={repo.nodeId} className="pl-3">
                  <p className="m-0 font-mono text-label leading-5 text-faint">{fullName(repo)}</p>
                  <ul className="m-0 list-none p-0">
                    {entries.map((entry) => (
                      <Entry
                        key={`${entry.text}:${entry.itemIds.join(',')}`}
                        entry={entry}
                        repo={repo}
                        onOpen={onOpen}
                        sources={sourcesOf?.(entry.itemIds) ?? []}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </section>
      ))}
      {detail.onFire.length === 0 && <Closing>Nothing on fire</Closing>}
    </div>
  );
}

// One entry: Ares's words (or Commander's, for what he left out), and what opens its Items.
function Entry({
  entry,
  repo,
  onOpen,
  sources,
}: {
  entry: GitHubSummaryEntry;
  repo: GitHubRepoName;
  onOpen: (target: SummaryTarget) => void;
  sources: string[];
}) {
  const text = entry.theme ? `${entry.theme}: ${entry.text}` : entry.text;
  const count = entry.itemIds.length;
  return (
    <li
      data-testid="github-summary-entry"
      className="flex items-baseline gap-3 py-0.5 text-note leading-5 text-text"
    >
      <span
        className="min-w-0 flex-1"
        title={entry.plain ? 'In Commander’s words: Ares left this out' : undefined}
      >
        {entry.theme && <b className="font-semibold">{entry.theme}: </b>}
        {entry.plain ? entry.text : <AresText inline text={entry.text} sources={sources} />}
      </span>
      <button
        type="button"
        data-testid="github-summary-open"
        aria-label={`Open: ${text}`}
        onClick={() => onOpen({ itemIds: entry.itemIds, repo, text })}
        className="flex-none cursor-pointer border-0 bg-transparent p-0 font-mono text-label leading-none font-medium uppercase tracking-label whitespace-nowrap text-muted hover:text-ink"
      >
        {count > 1 ? `Open ${count}` : count === 1 ? 'Open' : fullName(repo)}
      </button>
    </li>
  );
}

/** Ares's summaries, newest first: each reopens. */
function PastSummaries({
  summaries,
  shown,
  now,
  onPick,
}: {
  summaries: readonly GitHubSummaryItem[];
  shown: string | null;
  now: number;
  onPick: (summary: GitHubSummaryItem) => void;
}) {
  return (
    <ul
      aria-label="Past summaries"
      data-testid="github-summary-history"
      className="m-0 max-h-[200px] list-none overflow-auto border-b border-line2 bg-raise py-1 pr-5 pl-[41px] [scrollbar-width:thin]"
    >
      {summaries.map((summary) => (
        <li key={summary.id}>
          <button
            type="button"
            aria-current={summary.id === shown ? 'true' : undefined}
            onClick={() => onPick(summary)}
            className="flex w-full cursor-pointer items-baseline gap-3 border-0 bg-transparent p-0 py-0.5 text-left text-note leading-5 text-text hover:text-ink aria-[current=true]:font-semibold"
          >
            <span className="min-w-0 flex-1 truncate">{summary.title}</span>
            <span className="flex-none font-mono text-label text-faint">
              {whenWritten(summary.detail.writtenAt, now)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
