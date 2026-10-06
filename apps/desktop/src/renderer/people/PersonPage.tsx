import { type GitHubPeopleView, PEOPLE_RANGE_LABELS } from '@commander/domain';
import { cn, Kbd, SectionHeader, Sheet, SheetStripCell, toast } from '@commander/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { requestReveal } from '../frame/reveal';
import type { ItemChanges } from '../item-store/changes';
import { SideCard } from '../projects/page/SideCard';
import { type CardTarget, type ParagraphState, PersonCard } from '../sections/github/PersonCard';
import { type PeopleViewClient, spanOf } from '../sections/github/people';
import type { SettingsPlace } from '../settings/pages';
import { useShortcuts } from '../shortcuts/react';
import { usePeople } from './context';
import { PEOPLE_SETTINGS } from './PeopleSettings';
import { handleLabel, handleSourceName } from './people';

/** The shortcut scope of a Person's page: its keys work only while it is shown. */
export const PERSON_PAGE_SCOPE = 'person-page';

const RANGES = ['last-30-days', 'last-90-days'] as const;
type Range = (typeof RANGES)[number];
const pad = (n: number) => String(n).padStart(2, '0');

export interface PersonPageProps {
  personId: string;
  /** Whether the page is the one shown (it reloads when it comes back into view). */
  active: boolean;
  client: PeopleViewClient;
  /** Where `Esc` and the back control go: where the User came from. */
  back: { label: string; onClick: () => void };
  onOpenSection: (sectionId: string) => void;
  onOpenSettings: (place?: SettingsPlace) => void;
  changes?: ItemChanges;
  now?: () => number;
}

/**
 * A Person's page (#122), opened as a temporary tab like a Project's (from a People card, `Ctrl+K`
 * or their name in a detail pane): their People card over a longer range (the last 30 days, or 90),
 * with Merged and Reviewed open, Ares's latest paragraph and Refresh; and in the side column every
 * handle they have, by Source, and the way to Settings → People to merge or split them.
 */
export function PersonPage({
  personId,
  active,
  client,
  back,
  onOpenSection,
  onOpenSettings,
  changes,
  now = Date.now,
}: PersonPageProps) {
  const { people, loaded } = usePeople();
  const person = people.find((each) => each.id === personId);
  const [range, setRange] = useState<Range>('last-30-days');
  const [view, setView] = useState<GitHubPeopleView | null>(null);
  const [paragraph, setParagraph] = useState<ParagraphState | undefined>();
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload
  useEffect(() => {
    let current = true;
    client.person(personId, spanOf(range, now())).then(
      (next) => current && setView(next),
      (error: unknown) => toast(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      current = false;
    };
  }, [client, personId, range, version, now]);
  // Another Person shown: the last one's Refresh state goes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `personId` changing is the trigger
  useEffect(() => setParagraph(undefined), [personId]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useEffect(
    () =>
      changes?.(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(reload, 300);
      }),
    [changes, reload],
  );
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) reload();
    wasActive.current = active;
  }, [active, reload]);

  useShortcuts([
    { keys: 'Escape', label: 'Close the Person’s page', scope: PERSON_PAGE_SCOPE, run: back.onClick },
  ]);

  const card = view?.cards[0] ?? null;
  const writing = !!view && view.writer.enabled && !view.writer.off;
  const open = ({ itemId, kind }: CardTarget) => {
    const sectionId = kind === 'linear-issue' ? 'linear' : 'github';
    onOpenSection(sectionId);
    requestReveal(sectionId, itemId);
  };
  const refresh = () => {
    if (!client.refresh) return;
    setParagraph({ refreshing: true, problem: null });
    client.refresh(personId, spanOf(range, now())).then(
      (answer) => {
        setParagraph({ refreshing: false, problem: answer.problem });
        if (answer.paragraph) reload();
      },
      (error: unknown) =>
        setParagraph({ refreshing: false, problem: error instanceof Error ? error.message : String(error) }),
    );
  };
  const manage = () => {
    onOpenSettings({ group: 'people' });
    requestReveal(PEOPLE_SETTINGS, personId);
  };

  if (!person) {
    return (
      <Sheet
        data-testid="person-page"
        className="col-span-6 ml-3.5 min-h-[calc(100vh-var(--body))] border-t-0"
      >
        {loaded && (
          <SectionHeader eyebrow="Person" title="Gone" subtitle="This Person was merged into someone else." />
        )}
      </Sheet>
    );
  }

  const handles = person.handles;
  return (
    <>
      <Sheet
        data-testid="person-page"
        className="col-span-6 ml-3.5 flex min-h-[calc(100vh-var(--body))] flex-col border-t-0"
      >
        <SectionHeader
          size="dashboard"
          eyebrow="Person"
          meta={<SheetStripCell>{person.name} · in the watched GitHub repos</SheetStripCell>}
          title={<span className="min-w-0 truncate">{person.name}</span>}
          subtitle={
            <>
              {person.isUser ? 'You · ' : ''}
              <b>
                {handles.length} {handles.length === 1 ? 'handle' : 'handles'}
              </b>{' '}
              across {[...new Set(handles.map((each) => handleSourceName(each.source)))].join(', ')}
            </>
          }
          aside={
            <span className="flex items-center gap-[7px] pb-0.5 font-mono text-label leading-[19px] font-medium uppercase tracking-label whitespace-nowrap text-muted [&_kbd]:h-[17px] [&_kbd]:min-w-[17px] [&_kbd]:text-label">
              <Kbd>Esc</Kbd> Back to {back.label}
            </span>
          }
        />
        <div className="flex h-10 items-stretch border-b border-line bg-sheet">
          {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and form semantics */}
          <div
            role="group"
            aria-label="Person range"
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
                  range === kind
                    ? 'bg-raise font-semibold text-ink'
                    : 'font-medium text-muted hover:bg-raise',
                )}
              >
                {PEOPLE_RANGE_LABELS[kind]}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 pb-30">
          {card ? (
            <PersonCard
              card={card}
              now={now()}
              onOpen={open}
              onRefresh={writing && client.refresh ? refresh : undefined}
              paragraphState={paragraph}
              expanded
            />
          ) : (
            <p className="m-0 py-2.5 pr-5 pl-13 text-note text-faint">Reading…</p>
          )}
        </div>
      </Sheet>
      <aside className="relative col-span-2 min-w-0" aria-label={`${person.name}: handles`}>
        <div className="sticky top-(--body) mr-4 ml-3.5 flex max-h-[calc(100vh-var(--body))] flex-col gap-3.5 overflow-auto pt-3.5 pb-6 [scrollbar-width:none]">
          <SideCard label="Handles" title="Handles" note={pad(handles.length)}>
            <dl className="m-0" data-testid="person-handles">
              {handles.map((each) => (
                <div
                  key={each.handle}
                  className="flex justify-between gap-3 border-b border-line2 px-2.5 py-1.5 font-mono text-label leading-[1.2] font-medium uppercase tracking-tag last:border-b-0"
                >
                  <dt className="flex-none text-muted">{handleSourceName(each.source)}</dt>
                  <dd className="m-0 min-w-0 truncate font-semibold normal-case text-ink">
                    {handleLabel(each)}
                  </dd>
                </div>
              ))}
            </dl>
          </SideCard>
          <SideCard label="Merge or split" title="Merge or split">
            <p className="m-0 px-2.5 pt-2 text-note leading-[18px] text-muted">
              Commander matches People by email address. If this is two people, or one of several, change it
              in Settings.
            </p>
            <button
              type="button"
              data-testid="person-manage"
              onClick={manage}
              className="m-2.5 cursor-pointer border border-ink bg-transparent px-2.5 py-1.5 font-mono text-label leading-none font-semibold uppercase tracking-label text-ink hover:bg-raise"
            >
              Settings → People
            </button>
          </SideCard>
        </div>
      </aside>
    </>
  );
}
