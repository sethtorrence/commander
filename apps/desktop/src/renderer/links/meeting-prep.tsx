import {
  type AresActivity,
  type CoreMessage,
  type Item,
  isMeetingPrep,
  type MeetingPrep,
  PREPARE_MEETINGS,
  PREPARE_MEETINGS_NAME,
  type PrepLine,
  prepSources,
} from '@commander/domain';
import { AresText, toast } from '@commander/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ItemChanges } from '../item-store/changes';
import type { ItemStoreClient } from '../item-store/client';
import type { AutonomyClient } from '../sections/ares/activity';
import { kindTag } from '../sections/todos/links';

/*
  Meeting prep in the window (#130): Ares's prep for a meeting, read by its event, and the Todos the
  meeting asks for that wait as suggestions on it. Shown folded under the meeting chip in the Daily
  Note, in the event's detail pane and in the meeting's Dashboard row. Every line is a model's words,
  so it is drawn with AresText (a URL is clickable only if it is in the Items the line came from);
  beside it, the Items it rests on, which open where they live. Prepare now asks Ares for it again.
*/

const SUGGEST_TODOS = 'suggest-todos';

type CoreMessages = (listener: (message: CoreMessage) => void) => () => void;

export interface MeetingPreps {
  /** Each event's prep, by the event's id. */
  byEvent: ReadonlyMap<string, MeetingPrep>;
  /** The Items the preps' lines rest on (tombstones too), by id. */
  sources: ReadonlyMap<string, Item>;
}

const EMPTY: MeetingPreps = { byEvent: new Map(), sources: new Map() };

/** Reads the preps for these events, and the Items they rest on, again whenever Items change. */
export function useMeetingPreps(
  itemStore: ItemStoreClient,
  eventIds: readonly string[],
  { changes, active = true }: { changes?: ItemChanges; active?: boolean } = {},
): MeetingPreps {
  const [preps, setPreps] = useState<MeetingPreps>(EMPTY);
  const [version, setVersion] = useState(0);
  const key = [...new Set(eventIds)].sort().join(',');
  useEffect(() => changes?.(() => setVersion((v) => v + 1)), [changes]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the ids, `version` asks again
  useEffect(() => {
    const ids = key ? key.split(',') : [];
    if (!active) return;
    if (!ids.length) {
      setPreps(EMPTY);
      return;
    }
    let current = true;
    void (async () => {
      try {
        const found = (await itemStore({ op: 'meeting-preps', eventIds: ids.slice(0, 500) })).filter(
          isMeetingPrep,
        );
        const sourceIds = [...new Set(found.flatMap((prep) => prepSources(prep.detail)))].slice(0, 1000);
        const sources = sourceIds.length
          ? await itemStore({ op: 'query', query: { ids: sourceIds, includeDeleted: true, limit: 1000 } })
          : [];
        if (!current) return;
        setPreps({
          byEvent: new Map(found.map((prep) => [prep.detail.eventId, prep])),
          sources: new Map(sources.map((item) => [item.id, item])),
        });
      } catch {
        // Kept as it was: the next change asks again.
      }
    })();
    return () => {
      current = false;
    };
  }, [itemStore, key, version, active]);
  return preps;
}

/** A Todo a meeting asks for, waiting on its event for the User to Add or Dismiss. */
export interface EventSuggestion {
  id: number;
  eventId: string;
  title: string;
  reason: string;
}

export function eventSuggestionOf(row: AresActivity): EventSuggestion | null {
  if (row.status !== 'pending' || row.action !== SUGGEST_TODOS || row.item?.kind !== 'event') return null;
  const create = row.itemActions.find((step) => step.type === 'create' && step.item.kind === 'todo');
  if (create?.type !== 'create') return null;
  return { id: row.id, eventId: row.itemId, title: create.item.title, reason: row.reason };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface PrepActions {
  /** The suggestions waiting on each event, oldest first. */
  suggestions: ReadonlyMap<string, EventSuggestion[]>;
  settle(id: number, op: 'accept' | 'dismiss'): void;
  /** Asks Ares to prepare the meeting now (again). */
  prepare(eventId: string): void;
  /** Whether a Prepare now for the event is still running. */
  preparing(eventId: string): boolean;
}

/**
 * The suggestions on events (read again whenever Ares does or suggests something), Prepare now, and
 * which meetings are being prepared (until Ares's "Prepare for meetings" stops running).
 */
export function usePrepActions(
  client: AutonomyClient,
  onCoreMessage: CoreMessages,
  active = true,
): PrepActions {
  const [rows, setRows] = useState<EventSuggestion[]>([]);
  const [version, setVersion] = useState(0);
  const [asked, setAsked] = useState<ReadonlySet<string>>(new Set());
  const working = useRef(false);

  useEffect(
    () =>
      onCoreMessage((word) => {
        if (word.type === 'ares-activity') setVersion((v) => v + 1);
        if (word.type !== 'ares-status') return;
        const now = word.running.includes(PREPARE_MEETINGS_NAME);
        // Prepare now is done once the job stops running.
        if (working.current && !now) setAsked(new Set());
        working.current = now;
      }),
    [onCoreMessage],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks again
  useEffect(() => {
    if (!active) return;
    let current = true;
    client({ op: 'activity', query: { action: SUGGEST_TODOS, statuses: ['pending'], limit: 500 } }).then(
      (activity) => {
        if (!current) return;
        setRows(
          activity
            .map(eventSuggestionOf)
            .filter((row): row is EventSuggestion => row !== null)
            .reverse(),
        );
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [client, active, version]);

  const suggestions = useMemo(() => {
    const map = new Map<string, EventSuggestion[]>();
    for (const row of rows) map.set(row.eventId, [...(map.get(row.eventId) ?? []), row]);
    return map;
  }, [rows]);

  const settle = useCallback(
    (id: number, op: 'accept' | 'dismiss') => {
      setRows((was) => was.filter((row) => row.id !== id));
      client({ op, proposalId: id }).then(
        () => setVersion((v) => v + 1),
        (error) => {
          toast(message(error));
          setVersion((v) => v + 1);
        },
      );
    },
    [client],
  );

  const prepare = useCallback(
    (eventId: string) => {
      setAsked((was) => new Set([...was, eventId]));
      client({ op: 'run-job', job: PREPARE_MEETINGS, itemIds: [eventId] }).then(
        (state) => {
          // Off, or switched off in Settings → Ares: nothing will run.
          const job = state.jobs.find((each) => each.job === PREPARE_MEETINGS);
          if (job && !job.enabled) {
            toast('Prepare for meetings is switched off in Settings → Ares');
            setAsked(new Set());
          }
        },
        (error) => {
          toast(message(error));
          setAsked(new Set());
        },
      );
    },
    [client],
  );

  const preparing = useCallback((eventId: string) => asked.has(eventId), [asked]);
  return useMemo(
    () => ({ suggestions, settle, prepare, preparing }),
    [suggestions, settle, prepare, preparing],
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
const clockOf = (at: number) => `${pad(new Date(at).getHours())}:${pad(new Date(at).getMinutes())}`;

/** "Ready · 14:30": when Ares prepared it. */
export const prepReadyLabel = (prep: MeetingPrep) => `Ready · ${clockOf(prep.detail.preparedAt)}`;

// What a source is called beside a line: the issue's identifier, "Notes" for the User's notes, else
// its title, cut short.
function sourceName(item: Item | undefined): string {
  if (!item) return 'Item';
  if (item.detail?.kind === 'linear-issue') return item.detail.identifier;
  if (item.kind === 'block') return 'Notes';
  if (item.kind === 'event') return 'Invite';
  const title = item.title.replace(/\s+/g, ' ').trim();
  return title.length > 28 ? `${title.slice(0, 27)}…` : title || 'Item';
}

// Everything a source says, for what Ares wrote about it to link to.
function wordsOf(item: Item | undefined): string[] {
  if (!item) return [];
  const detail = item.detail;
  if (detail?.kind === 'linear-issue')
    return [item.title, detail.description ?? '', ...detail.comments.map((comment) => comment.body)];
  if (detail?.kind === 'event') return [item.title, detail.description ?? '', detail.meetingUrl ?? ''];
  if (detail?.kind === 'block') return [detail.text];
  if (detail?.kind === 'chat') return [item.title, ...detail.messages.map((each) => each.text)];
  return [item.title];
}

const PARTS = [
  ['about', 'About'],
  ['lastTime', 'Last time'],
  ['open', 'Open'],
  ['raise', 'Worth raising'],
] as const;

/** A prep's lines, under their headings, each with the Items it rests on. */
export function PrepBody({
  prep,
  sources,
  onOpenSource,
  className,
}: {
  prep: MeetingPrep;
  sources: ReadonlyMap<string, Item>;
  /** Opens a source where it lives. */
  onOpenSource: (item: Item) => void;
  className?: string;
}) {
  const parts = PARTS.map(([field, label]) => {
    const value = prep.detail[field];
    const lines: PrepLine[] = Array.isArray(value) ? value : value ? [value] : [];
    return { field, label, lines };
  }).filter((part) => part.lines.length > 0);
  if (!parts.length)
    return (
      <p className={className} data-testid="prep-body">
        Nothing to prepare: Ares found nothing that holds up.
      </p>
    );
  return (
    <div className={className} data-testid="prep-body">
      {parts.map(({ field, label, lines }) => (
        <section key={field} aria-label={label} data-part={field} className="mt-2 first:mt-0">
          <h4 className="m-0 font-mono text-label leading-[18px] font-semibold uppercase tracking-tag text-muted">
            {label}
          </h4>
          <ul className="m-0 list-none p-0">
            {lines.map((line, index) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: a prep's lines never move
                key={index}
                data-testid="prep-line"
                className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-0.5 text-note leading-[19px] text-text"
              >
                <span>
                  <AresText
                    inline
                    text={line.text}
                    sources={line.sources.flatMap((id) => wordsOf(sources.get(id)))}
                  />
                </span>
                {line.sources.map((id) => {
                  const item = sources.get(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      data-testid="prep-source"
                      disabled={!item}
                      title={item ? `${item.title}: open it` : 'No longer in Commander'}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => item && onOpenSource(item)}
                      className="inline-flex h-[17px] cursor-pointer items-center gap-1 border border-line bg-sheet px-1 font-mono text-tiny leading-none font-medium uppercase tracking-tag text-muted hover:border-ink hover:text-ink disabled:cursor-default disabled:opacity-50"
                    >
                      <b className="font-semibold">{kindTag(item?.kind ?? '')}</b>
                      {sourceName(item)}
                    </button>
                  );
                })}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
