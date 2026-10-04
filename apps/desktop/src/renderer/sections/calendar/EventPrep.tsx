import { type Item, isPrepWorthy } from '@commander/domain';
import { AresText } from '@commander/ui';
import { useMemo } from 'react';
import { requestReveal } from '../../frame/reveal';
import { itemChangesFromCore } from '../../item-store/changes';
import { PrepBody, prepReadyLabel, useMeetingPreps, usePrepActions } from '../../links/meeting-prep';
import { useOpenSection } from '../section';
import { Eyebrow, PaneEmpty } from '../todos/detail/parts';
import { sectionFor } from '../todos/links';

const button =
  'flex h-6 cursor-pointer items-center border border-line bg-sheet px-2 font-mono text-label leading-none font-semibold uppercase tracking-label whitespace-nowrap text-ink hover:border-ink disabled:cursor-progress disabled:text-faint';

/**
 * The event detail pane's Prep (#130): Ares's prep for the meeting, unfolded, with Prepare now and the
 * Todos the meeting asks for. Nothing for an event Ares doesn't prepare (no one else in it, declined,
 * cancelled) unless he already has.
 */
export function EventPrep({ event }: { event: Item }) {
  const ids = useMemo(() => [event.id], [event.id]);
  const preps = useMeetingPreps(window.commander.itemStore, ids, { changes: itemChangesFromCore });
  const actions = usePrepActions(window.commander.autonomy, window.commander.onCoreMessage);
  const openSection = useOpenSection();
  const prep = preps.byEvent.get(event.id);
  if (!prep && !isPrepWorthy(event)) return null;
  const preparing = actions.preparing(event.id);
  const suggestions = actions.suggestions.get(event.id) ?? [];
  const openSource = (item: Item) => {
    const section = sectionFor(item.kind);
    if (!section) return;
    requestReveal(section, item.id);
    openSection(section);
  };
  return (
    <section aria-label="Prep" className="mt-[18px]" data-testid="event-prep">
      <div className="mb-2 flex items-center gap-2.5">
        <Eyebrow>Prep</Eyebrow>
        <span
          className="font-mono text-label uppercase tracking-tag text-muted"
          data-testid="meeting-prep-state"
        >
          {preparing ? 'Preparing…' : prep ? prepReadyLabel(prep) : 'Not prepared yet'}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className={button}
          disabled={preparing}
          onClick={() => actions.prepare(event.id)}
        >
          Prepare now
        </button>
      </div>
      {suggestions.map((suggestion) => (
        <div
          key={suggestion.id}
          data-testid="prep-suggestion"
          className="mb-1.5 flex items-center gap-2 px-2.5 py-1 text-note outline-1 -outline-offset-1 outline-dashed outline-line"
        >
          <span className="flex-1 text-ink">
            Todo: <AresText inline text={suggestion.title} sources={[]} />
          </span>
          <button type="button" className={button} onClick={() => actions.settle(suggestion.id, 'accept')}>
            Add
          </button>
          <button type="button" className={button} onClick={() => actions.settle(suggestion.id, 'dismiss')}>
            Dismiss
          </button>
        </div>
      ))}
      {prep ? (
        <PrepBody
          className="border border-line px-3.5 py-3"
          prep={prep}
          sources={preps.sources}
          onOpenSource={openSource}
        />
      ) : (
        <PaneEmpty>Ares prepares a meeting half an hour before it.</PaneEmpty>
      )}
    </section>
  );
}
