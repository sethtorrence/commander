import type { Item, Project } from '@commander/domain';
import { SuggestedFiling } from '@commander/ui';
import { usePickBadge } from '../BadgePicker';

/** The Items Ares suggested this Project for and is waiting on (Todos answer for their issues). */
export function suggestedFor(projectId: string, items: readonly Item[]): Item[] {
  return items.filter(
    (item) => !item.filing && item.kind !== 'todo' && item.filingSuggestion?.projectId === projectId,
  );
}

const titleOf = (item: Item) =>
  item.detail?.kind === 'linear-issue' ? `${item.detail.identifier} ${item.title}` : item.title;

/**
 * On a Project's page: the Items Ares thinks belong here but wasn't sure about, each with the dashed
 * Badge, Confirm and Change (#71).
 */
export function SuggestedHere({ project, items }: { project: Project; items: readonly Item[] }) {
  const pick = usePickBadge();
  return (
    <ol aria-label={`Ares suggests ${project.name} for`} className="m-0 list-none p-0">
      {items.map((item) => {
        const target = { ...item, title: titleOf(item) };
        return (
          <li
            key={item.id}
            data-item-id={item.id}
            data-testid="suggested-here"
            className="flex min-h-10 items-center gap-3 border-b border-line2 py-[5px] pr-5 pl-13"
          >
            <span className="min-w-0 flex-1 truncate text-row leading-[22px] text-ink">{target.title}</span>
            <SuggestedFiling
              code={project.code}
              accent={project.accent}
              project={project.name}
              onConfirm={() => pick?.confirm?.(target)}
              onChange={() => pick?.(target)}
            />
          </li>
        );
      })}
    </ol>
  );
}
