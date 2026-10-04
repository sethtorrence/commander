import {
  type OversightRangeChoice,
  type OversightSummary,
  type PlainLine,
  type PlainSummary,
  plainSummary,
} from '@commander/domain';
import {
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
import { type OversightClient, type OversightScope, spanOf } from './oversight';

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

// "2026-10-01": a week before today, the custom range's first suggestion.
function aWeekAgo(now: number): string {
  const day = new Date(now - 7 * 24 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/**
 * The oversight summary at the top of the GitHub Section (#119), in a collapsible panel: its facts
 * in plain lines (what Shipped, Started, is Stuck and is On fire, per Project then repo,
 * ending "Nothing on fire"), with a range picker (Since yesterday, This week, Custom since…) and a
 * Project picker. Every line opens its Items in the Section. It is read again when Items change or a
 * sync finishes. Ares writes it properly in #121.
 */
export function OversightPanel({
  client,
  accounts,
  changes,
  onOpen,
  storage = window.localStorage,
  now = Date.now,
}: {
  client: OversightClient;
  accounts?: GitHubAccountsClient;
  changes?: ItemChanges;
  onOpen: (line: PlainLine) => void;
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
  const [range, setRange] = useState<OversightRangeChoice['kind']>('since-yesterday');
  const [since, setSince] = useState(() => aWeekAgo(now()));
  const [scope, setScope] = useState<OversightScope>('everything');
  const [summary, setSummary] = useState<OversightSummary | null>(null);
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

  // Read again when Items change (a sync, filing) or a sync finishes (repo health), and on coming
  // back to the Section, a little after the last word.
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

  const plain: PlainSummary | null = useMemo(() => (summary ? plainSummary(summary) : null), [summary]);
  const shownProject = projects.find((project) => project.id === scope);

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
      {open && (
        <div className="max-h-[320px] overflow-auto py-2 pr-5 pl-[41px] [scrollbar-width:thin]">
          {!plain ? (
            <p className="m-0 py-1 text-note text-faint">
              {choice ? 'Reading…' : 'Choose a day to start from.'}
            </p>
          ) : (
            <>
              {plain.sections.map((section) =>
                section.kind === 'on-fire' && !section.groups.length ? null : (
                  <section key={section.kind} aria-label={section.title} className="py-1">
                    <h3 className="m-0 font-mono text-label leading-6 font-semibold uppercase tracking-label text-muted">
                      {section.title}
                    </h3>
                    {section.groups.length ? (
                      section.groups.map((group) => (
                        <div key={group.project?.id ?? 'unfiled'} className="pl-3">
                          <p className="m-0 text-note leading-5 font-semibold text-text">{group.title}</p>
                          <ul className="m-0 list-none p-0 pl-3">
                            {group.lines.map((line) => (
                              <li key={`${line.text}:${line.itemIds.join(',')}`}>
                                <button
                                  type="button"
                                  data-testid="github-summary-line"
                                  onClick={() => onOpen(line)}
                                  className="cursor-pointer border-0 bg-transparent p-0 text-left text-note leading-5 text-text hover:text-ink hover:underline"
                                >
                                  {line.text}
                                </button>
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
              {plain.closing && (
                <p
                  data-testid="github-summary-closing"
                  className="m-0 py-1 text-note leading-5 font-semibold text-text"
                >
                  {plain.closing}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
