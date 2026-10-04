import './meeting-prep.css';
import { type Item, isPrepWorthy } from '@commander/domain';
import { AresText } from '@commander/ui';
import { createContext, useContext, useState } from 'react';
import { type MeetingPreps, type PrepActions, PrepBody, prepReadyLabel } from '../../links/meeting-prep';

/*
  A meeting chip's Prep (#130): a folded section under the chip's row, outside the Blocks, so the
  User's notes under the chip stay theirs and opening it edits nothing. It says whether Ares has
  prepared the meeting (Prepare now asks him again), lists the Todos the meeting asks for that wait as
  suggestions (Add, Dismiss), and unfolds to the prep itself.
*/

export interface ChipPrep {
  preps: MeetingPreps;
  actions: PrepActions;
  /** The events behind the chips on screen, by id. */
  events: ReadonlyMap<string, Item>;
  /** Opens one of a prep's sources where it lives. */
  openSource(item: Item): void;
}

/** What the meeting chips on screen show of their preps; none where there are no chips (the template). */
export const ChipPrepContext = createContext<ChipPrep | null>(null);

export function MeetingPrep({ eventId }: { eventId: string }) {
  const context = useContext(ChipPrepContext);
  const [open, setOpen] = useState(false);
  if (!context) return null;
  const { preps, actions, events, openSource } = context;
  const prep = preps.byEvent.get(eventId);
  const event = events.get(eventId);
  // Only meetings Ares prepares (someone else in them, not declined or cancelled), or one he has.
  if (!prep && !isPrepWorthy(event)) return null;
  const preparing = actions.preparing(eventId);
  const suggestions = actions.suggestions.get(eventId) ?? [];
  const state = preparing ? 'Preparing…' : prep ? prepReadyLabel(prep) : 'Not prepared yet';
  return (
    <div
      className="n-prep"
      data-testid="meeting-prep"
      data-event={eventId}
      data-ready={prep ? '' : undefined}
    >
      <div className="n-prep-bar">
        <button
          type="button"
          className="n-prep-toggle"
          aria-expanded={open}
          disabled={!prep}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((was) => !was)}
          title={
            prep ? (open ? 'Fold the prep' : 'Unfold the prep') : 'Ares hasn’t prepared this meeting yet'
          }
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> Prep
        </button>
        <span className="n-prep-state" data-testid="meeting-prep-state">
          {state}
        </span>
        <button
          type="button"
          className="n-prep-now"
          tabIndex={-1}
          disabled={preparing}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => actions.prepare(eventId)}
        >
          Prepare now
        </button>
      </div>
      {suggestions.map((suggestion) => (
        <div key={suggestion.id} className="n-prep-suggestion" data-testid="prep-suggestion">
          <span className="n-prep-suggestion-title">
            Todo: <AresText inline text={suggestion.title} sources={[]} />
          </span>
          <button type="button" tabIndex={-1} onClick={() => actions.settle(suggestion.id, 'accept')}>
            Add
          </button>
          <button type="button" tabIndex={-1} onClick={() => actions.settle(suggestion.id, 'dismiss')}>
            Dismiss
          </button>
        </div>
      ))}
      {open && prep && (
        <PrepBody className="n-prep-body" prep={prep} sources={preps.sources} onOpenSource={openSource} />
      )}
    </div>
  );
}
