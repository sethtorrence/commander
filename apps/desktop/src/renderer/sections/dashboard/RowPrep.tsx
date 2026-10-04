import type { Item } from '@commander/domain';
import { AresText, cn } from '@commander/ui';
import { createContext, useContext, useState } from 'react';
import { type MeetingPreps, PrepBody, prepReadyLabel } from '../../links/meeting-prep';

/*
  A meeting's prep on its Dashboard row (#130): under the meeting's row (the next meeting is ranked
  into Now), what it is about in Ares's words, folded, with the whole prep a click away. Provided by
  the Dashboard Section (index.tsx); a list without it (a Project page) shows none.
*/

export interface RowPreps {
  preps: MeetingPreps;
  openSource(item: Item): void;
}

export const RowPrepContext = createContext<RowPreps | null>(null);

export function RowPrep({ item }: { item: Item }) {
  const context = useContext(RowPrepContext);
  const [open, setOpen] = useState(false);
  const prep = item.kind === 'event' ? context?.preps.byEvent.get(item.id) : undefined;
  if (!context || !prep) return null;
  const about = prep.detail.about ?? prep.detail.raise[0] ?? prep.detail.open[0] ?? prep.detail.lastTime[0];
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: stops the row's own clicks; the buttons inside are the controls
    // biome-ignore lint/a11y/useKeyWithClickEvents: as above
    <div className="mt-1.5" data-testid="row-prep" onClick={(event) => event.stopPropagation()}>
      <div className="flex flex-wrap items-baseline gap-x-2 text-note leading-[19px] text-muted">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
          className={cn(
            'cursor-pointer border-0 bg-transparent p-0 font-mono text-label font-semibold uppercase tracking-tag',
            'text-ink hover:underline',
          )}
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> Prep
        </button>
        <span className="font-mono text-tiny uppercase tracking-tag">{prepReadyLabel(prep)}</span>
        {!open && about && (
          <span className="min-w-0">
            <AresText inline text={about.text} sources={[]} />
          </span>
        )}
      </div>
      {open && (
        <PrepBody
          className="mt-1.5"
          prep={prep}
          sources={context.preps.sources}
          onOpenSource={context.openSource}
        />
      )}
    </div>
  );
}
