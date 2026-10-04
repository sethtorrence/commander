import './margin-cards.css';
import { AresText } from '@commander/ui';
import { useLayoutEffect, useRef } from 'react';
import type { MarginSuggestion } from './margin-suggestions';

/*
  Ares's margin cards on a Daily Note's sheet (after the prototype's .agent-card, round-3/
  industrial.html): one per suggestion, level with the Block it is for, stacked below the outliner
  key and each other where they would overlap. Pointing at a card marks its Block.
*/

const GAP = 10;

// Where the day's Block sits, relative to the margin.
function anchorTop(day: string, blockId: string, margin: HTMLElement): number | null {
  const block = document.querySelector<HTMLElement>(`#day-${day} [data-block="${blockId}"]`);
  if (!block) return null;
  return block.getBoundingClientRect().top - margin.getBoundingClientRect().top;
}

function markBlock(day: string, blockId: string, on: boolean) {
  const block = document.querySelector<HTMLElement>(`#day-${day} [data-block="${blockId}"]`);
  if (on) block?.setAttribute('data-ares-mark', '');
  else block?.removeAttribute('data-ares-mark');
}

export function MarginCards({
  day,
  suggestions,
  onAdd,
  onDismiss,
}: {
  day: string;
  suggestions: readonly MarginSuggestion[];
  onAdd: (id: number) => void;
  onDismiss: (id: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: laid out again whenever the cards change
  useLayoutEffect(() => {
    const margin = ref.current;
    if (!margin) return;
    const layout = () => {
      // Below the outliner key, where today's margin has one.
      const key = margin.parentElement?.querySelector<HTMLElement>('.n-legend');
      let floor = key ? key.offsetTop + key.offsetHeight + GAP : 0;
      for (const card of margin.querySelectorAll<HTMLElement>('[data-ares-card]')) {
        const wanted = anchorTop(day, card.dataset.block ?? '', margin) ?? floor;
        const top = Math.max(wanted, floor);
        card.style.top = `${top}px`;
        floor = top + card.offsetHeight + GAP;
      }
    };
    layout();
    const section = document.getElementById(`day-${day}`);
    if (!section || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(layout);
    observer.observe(section);
    return () => observer.disconnect();
  }, [day, suggestions]);

  if (!suggestions.length) return null;
  return (
    <div className="n-acs" ref={ref} data-testid="margin-cards">
      {suggestions.map((suggestion, index) => (
        // biome-ignore lint/a11y/useSemanticElements: a card holding two buttons, not a form's fieldset
        <div
          key={suggestion.id}
          className="n-ac"
          role="group"
          aria-label={`Suggested by Ares: ${suggestion.title}`}
          data-ares-card=""
          data-block={suggestion.blockId}
          data-testid="margin-card"
          onMouseEnter={() => markBlock(day, suggestion.blockId, true)}
          onMouseLeave={() => markBlock(day, suggestion.blockId, false)}
        >
          <div className="n-ac-head">
            <span className="n-ac-tag">T-{String(index + 1).padStart(2, '0')}</span>
            <span>Ares noticed</span>
            <span className="n-ac-src">from this note</span>
          </div>
          <div className="n-ac-body">
            <div className="n-ac-todo">
              <span className="bx" aria-hidden="true" />
              <span>
                <span className="n-ac-kind">Todo: </span>
                <AresText inline text={suggestion.title} sources={[suggestion.source]} />
              </span>
            </div>
            <div className="n-ac-why">
              <AresText inline text={suggestion.reason} sources={[suggestion.source]} />
            </div>
          </div>
          <div className="n-ac-actions">
            <button
              type="button"
              className="n-ac-add"
              onClick={() => {
                markBlock(day, suggestion.blockId, false);
                onAdd(suggestion.id);
              }}
            >
              Add
            </button>
            <button
              type="button"
              className="n-ac-dismiss"
              title="Ares won’t offer it again for this Block’s text"
              onClick={() => {
                markBlock(day, suggestion.blockId, false);
                onDismiss(suggestion.id);
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
