import { type PersonCard as Card, type GitHubPeopleView, PEOPLE_RANGE_LABELS } from '@commander/domain';
import { cn, toast } from '@commander/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ItemChanges } from '../../item-store/changes';
import { useSection } from '../section';
import { type CardTarget, type ParagraphState, PersonCard } from './PersonCard';
import { inNameOrder, type PeopleScope, type PeopleViewClient, spanOf } from './people';

export const PEOPLE_RANGE_KEY = 'commander.github.people.range';

const RANGES = ['this-week', 'last-7-days'] as const;
type Range = (typeof RANGES)[number];

function loadRange(storage: Storage): Range {
  try {
    return storage.getItem(PEOPLE_RANGE_KEY) === 'last-7-days' ? 'last-7-days' : 'this-week';
  } catch {
    return 'this-week';
  }
}

/**
 * The People view (#122), the GitHub Section's fourth view: one card per Person active in the watched
 * repos in the range (This week, the default, from Monday; or the last 7 days), always by name and
 * never by their numbers, narrowed by the Section's Project filter (People with no work in that
 * Project drop out). Each card opens its pull requests and Linear issues, and its Person's page.
 *
 * It is read again when Items change (a sync, a paragraph written) and on coming back to the Section.
 */
export function PeopleView({
  client,
  scope,
  changes,
  onOpen,
  onOpenPerson,
  sourcesOf,
  storage = window.localStorage,
  now = Date.now,
}: {
  client: PeopleViewClient;
  scope: PeopleScope;
  changes?: ItemChanges;
  onOpen: (target: CardTarget) => void;
  onOpenPerson?: (personId: string) => void;
  sourcesOf?: (itemIds: readonly string[]) => string[];
  storage?: Storage;
  now?: () => number;
}) {
  const { active } = useSection();
  const [range, setRangeState] = useState<Range>(() => loadRange(storage));
  const [view, setView] = useState<GitHubPeopleView | null>(null);
  const [paragraphs, setParagraphs] = useState<Record<string, ParagraphState>>({});
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  const setRange = (next: Range) => {
    setRangeState(next);
    try {
      storage.setItem(PEOPLE_RANGE_KEY, next);
    } catch {
      // Storage unavailable: it applies for this session.
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload
  useEffect(() => {
    let current = true;
    client.week(spanOf(range, now()), scope).then(
      (next) => current && setView(next),
      (error: unknown) => toast(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      current = false;
    };
  }, [client, range, scope, version, now]);

  // Read again a little after Items change, and on coming back to the Section.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(reload, 300);
  }, [reload]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useEffect(() => changes?.(() => soon()), [changes, soon]);
  useEffect(() => {
    if (active) reload();
  }, [active, reload]);

  const cards = useMemo(() => inNameOrder(view?.cards ?? []), [view]);
  const writing = !!view && view.writer.enabled && !view.writer.off;

  const refresh = (card: Card) => {
    const personId = card.personId;
    if (!client.refresh || !personId) return;
    setParagraphs((was) => ({ ...was, [card.key]: { refreshing: true, problem: null } }));
    client.refresh(personId, spanOf(range, now())).then(
      (answer) => {
        setParagraphs((was) => ({ ...was, [card.key]: { refreshing: false, problem: answer.problem } }));
        if (answer.paragraph) {
          const paragraph = answer.paragraph;
          setView(
            (was) =>
              was && {
                ...was,
                cards: was.cards.map((each) => (each.key === card.key ? { ...each, paragraph } : each)),
              },
          );
        }
      },
      (error: unknown) =>
        setParagraphs((was) => ({
          ...was,
          [card.key]: { refreshing: false, problem: error instanceof Error ? error.message : String(error) },
        })),
    );
  };

  const at = now();
  return (
    <section aria-label="People" data-testid="github-people" className="flex-1 pb-30">
      <div className="flex h-10 items-stretch border-b border-line bg-sheet">
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and form semantics */}
        <div
          role="group"
          aria-label="People range"
          className="ml-[41px] flex items-stretch border-l border-line2"
        >
          {RANGES.map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={range === kind}
              onClick={() => setRange(kind)}
              className={cn(
                'cursor-pointer border-0 border-r border-line2 bg-transparent px-3 font-mono text-label leading-none uppercase tracking-label whitespace-nowrap',
                range === kind ? 'bg-raise font-semibold text-ink' : 'font-medium text-muted hover:bg-raise',
              )}
            >
              {PEOPLE_RANGE_LABELS[kind]}
            </button>
          ))}
        </div>
        <p className="m-0 ml-auto self-center px-4 font-mono text-label leading-none font-medium uppercase tracking-label text-faint">
          {view ? `${cards.length} ${cards.length === 1 ? 'person' : 'people'} · by name` : 'Reading…'}
        </p>
      </div>
      {view && !cards.length && (
        <p className="hatch m-0 border-b border-line2 py-2.5 pr-5 pl-13 text-note text-faint">
          No one was active in the watched repos {range === 'this-week' ? 'this week' : 'in the last 7 days'}
          {scope === 'everything' ? '' : ' in this Project'}.
        </p>
      )}
      {cards.map((card) => (
        <PersonCard
          key={card.key}
          card={card}
          now={at}
          onOpen={onOpen}
          onOpenPerson={onOpenPerson}
          onRefresh={writing && client.refresh && card.personId ? () => refresh(card) : undefined}
          paragraphState={paragraphs[card.key]}
          sourcesOf={sourcesOf}
        />
      ))}
    </section>
  );
}
