import type { Item, TodoOrigin } from '@commander/domain';

// Where a Todo came from, as its row and the detail pane label it. Keyed by every origin the
// domain knows, so a new origin (Daily Note, once Blocks can become Todos) must get its label here.
const ORIGIN_LABELS: Record<TodoOrigin, string> = { manual: 'Manual', ares: 'Ares', linear: 'Linear' };

export function originOf(todo: Item): TodoOrigin {
  return todo.detail?.kind === 'todo' ? todo.detail.origin : 'manual';
}

export function originLabel(todo: Item): string {
  return ORIGIN_LABELS[originOf(todo)];
}
