import type { Item } from '@commander/domain';
import { Badge } from '@commander/ui';

/*
  Where a Todo's Project shows: the Badge slot on its row and the Project line in the detail pane.
  Until Projects land every Todo is Unfiled; the Badge picker and filed Badges replace these.
*/

/** The Todo's Badge, in the row's Badge slot. */
export function TodoBadge({ todo }: { todo: Item }) {
  return todo.filing ? null : <Badge kind="unfiled" />;
}

/** The Todo's Project, for the detail pane's Project line. */
export function TodoProject({ todo }: { todo: Item }) {
  return (
    <span className="flex items-center justify-end gap-[9px]">
      <TodoBadge todo={todo} />
      {todo.filing ? null : 'Unfiled'}
    </span>
  );
}
