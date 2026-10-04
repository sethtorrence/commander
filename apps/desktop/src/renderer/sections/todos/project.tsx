import type { Item } from '@commander/domain';
import { usePickBadge } from '../../projects/BadgePicker';
import { ItemBadge, ItemProject, useAccentBar } from '../../projects/badges';

/*
  Where a Todo's Project shows: the Badge slot on its row and the Project line in the detail pane.
  The Badges, the picker and the filter themselves live in projects/.
*/

/**
 * The Todo's Badge, in the row's Badge slot, with its Project's accent as the row's thin left bar.
 * Clicking it opens the Badge picker, as `b` does.
 */
export function TodoBadge({ todo }: { todo: Item }) {
  const pick = usePickBadge();
  const bar = useAccentBar(todo.filing);
  return (
    <>
      {/* Positioned against the row: a 2px bar beside the row number. Unfiled rows have none. */}
      {bar && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-px bottom-0 left-[39px] w-0.5"
          style={{ background: bar }}
        />
      )}
      {pick ? (
        <button
          type="button"
          data-item-id={todo.id}
          title="Change the Project (B)"
          aria-label={`Project of ${todo.title}`}
          onClick={(event) => {
            event.stopPropagation();
            pick(todo, event.currentTarget);
          }}
          className="flex cursor-pointer border-0 bg-transparent p-0 hover:outline hover:outline-offset-1 hover:outline-ink focus-visible:outline focus-visible:outline-offset-1 focus-visible:outline-ink"
        >
          <ItemBadge filing={todo.filing} suggestion={todo.filingSuggestion} />
        </button>
      ) : (
        <ItemBadge filing={todo.filing} suggestion={todo.filingSuggestion} />
      )}
    </>
  );
}

/**
 * The Todo's Project, for the detail pane's Project line: its Badge and name, or Unfiled; or Ares's
 * dashed Badge with Confirm and Change, for a Todo whose issue he suggested a Project for.
 */
export function TodoProject({ todo }: { todo: Item }) {
  return <ItemProject item={todo} />;
}
