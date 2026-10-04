import type { AresActivity } from '@commander/domain';
import { toast } from '@commander/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AutonomyClient } from '../ares/activity';
import { type AgendaDay, dayKey, dayTitle } from './agenda';

/*
  Focus time in the Calendar Section (#131): Ares's focus block suggestions ("Block time for Todos",
  Tidy your Sources, Ask by default), each with Accept and Dismiss and all of them with Accept all, and
  the focus blocks accepted, each with Undo (it takes the event out of the Commander calendar again).
  Read from the gate, again whenever the Core says Ares did or suggested something. Plan focus time asks
  him to plan now, from the palette, this Section or the Todos Section.
*/

// The job, and the action its suggestions carry.
export const BLOCK_TIME_FOR_TODOS = 'block-time-for-todos';

/** A focus block Ares suggests (or one accepted): its Todo, its time and why. */
export interface FocusBlock {
  /** The suggestion (the gate's proposal) id. */
  id: number;
  todoId: string;
  /** The Todo's title, which Ares's words may quote (AresText). */
  todoTitle: string;
  /** The event's title: "Focus: <Todo title>". */
  title: string;
  start: number;
  end: number;
  reason: string;
}

/** A gate proposal as the focus block it would make (or made); null for any other. */
export function focusBlockOf(row: AresActivity): FocusBlock | null {
  if (row.action !== BLOCK_TIME_FOR_TODOS) return null;
  const step = row.itemActions.find((action) => action.type === 'create-event');
  if (step?.type !== 'create-event' || step.event.kind !== 'focus-block') return null;
  return {
    id: row.id,
    todoId: row.itemId,
    todoTitle: row.item?.title ?? '',
    title: step.event.title,
    start: step.event.start.at,
    end: step.event.end.at,
    reason: row.reason,
  };
}

/** The pending suggestions, earliest first, and the accepted blocks still to come that can be undone. */
export function focusTimeOf(rows: readonly AresActivity[], now: number) {
  const suggestions: FocusBlock[] = [];
  const planned: FocusBlock[] = [];
  for (const row of rows) {
    const block = focusBlockOf(row);
    if (!block) continue;
    if (row.status === 'pending') suggestions.push(block);
    else if ((row.status === 'accepted' || row.status === 'done') && row.undoable && block.end > now)
      planned.push(block);
  }
  const byStart = (a: FocusBlock, b: FocusBlock) => a.start - b.start || a.id - b.id;
  return { suggestions: suggestions.sort(byStart), planned: planned.sort(byStart) };
}

/**
 * The Agenda's days with the days Ares suggests focus blocks on added (a day with no events isn't
 * listed otherwise), within the days it shows.
 */
export function withSuggestionDays(
  agenda: readonly AgendaDay[],
  byDay: ReadonlyMap<string, readonly FocusBlock[]>,
  { today, from, last }: { today: string; from: string; last: string },
): AgendaDay[] {
  const listed = new Set(agenda.map((day) => day.day));
  const added = [...byDay.keys()]
    .filter((day) => !listed.has(day) && day >= from && day <= last)
    .map((day) => ({ day, title: dayTitle(day, today), entries: [] }));
  if (!added.length) return [...agenda];
  return [...agenda, ...added].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** Asks Ares to plan focus time now. */
export const planFocusTime = (client: AutonomyClient) =>
  client({ op: 'run-job', job: BLOCK_TIME_FOR_TODOS }).then(() => undefined);

export interface FocusTime {
  suggestions: FocusBlock[];
  /** The suggestions by the day (YYYY-MM-DD, in the User's zone) they start on. */
  byDay: ReadonlyMap<string, FocusBlock[]>;
  planned: FocusBlock[];
  plan(): Promise<void>;
  accept(id: number): Promise<void>;
  dismiss(id: number): Promise<void>;
  acceptAll(): Promise<void>;
  undo(id: number): Promise<void>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function useFocusTime({
  client,
  onAresActivity,
  shown,
  now,
  timeZone,
  onChanged,
}: {
  client: AutonomyClient;
  onAresActivity: (listener: () => void) => () => void;
  shown: boolean;
  now: number;
  timeZone: string;
  /** After accepting or undoing: the Agenda reads its events again. */
  onChanged?: () => void;
}): FocusTime {
  const [rows, setRows] = useState<AresActivity[]>([]);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => onAresActivity(reload), [onAresActivity, reload]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload
  useEffect(() => {
    if (!shown) return;
    let current = true;
    client({ op: 'activity', query: { action: BLOCK_TIME_FOR_TODOS, limit: 500 } }).then(
      (activity) => {
        if (current) setRows(activity);
      },
      (error) => toast(message(error)),
    );
    return () => {
      current = false;
    };
  }, [client, shown, version]);

  const { suggestions, planned } = useMemo(() => focusTimeOf(rows, now), [rows, now]);
  const byDay = useMemo(() => {
    const map = new Map<string, FocusBlock[]>();
    for (const block of suggestions) {
      const day = dayKey(block.start, timeZone);
      map.set(day, [...(map.get(day) ?? []), block]);
    }
    return map;
  }, [suggestions, timeZone]);

  const run = useCallback(
    async (request: () => Promise<unknown>, changed: boolean) => {
      try {
        await request();
        if (changed) onChanged?.();
      } catch (error) {
        toast(message(error));
      }
      reload();
    },
    [reload, onChanged],
  );

  return {
    suggestions,
    byDay,
    planned,
    plan: async () => {
      try {
        await planFocusTime(client);
        toast('Ares is looking for time for your Todos.');
      } catch (error) {
        toast(message(error));
      }
    },
    accept: (id) => run(() => client({ op: 'accept', proposalId: id }), true),
    dismiss: (id) => run(() => client({ op: 'dismiss', proposalId: id }), false),
    acceptAll: () =>
      suggestions.length
        ? run(() => client({ op: 'accept-all', proposalIds: suggestions.map((each) => each.id) }), true)
        : Promise.resolve(),
    undo: (id) => run(() => client({ op: 'undo', proposalId: id }), true),
  };
}
