import type { Item, TodoOrigin } from '@commander/domain';
import type { MadeFrom } from './todos';

// Where a Todo came from, as its row and the detail pane label it. Keyed by every origin the
// domain knows, so a new origin must get its label here.
const ORIGIN_LABELS: Record<TodoOrigin, string> = {
  manual: 'Manual',
  ares: 'Ares',
  linear: 'Linear',
  'daily-note': 'Daily Note',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function originOf(todo: Item): TodoOrigin {
  return todo.detail?.kind === 'todo' ? todo.detail.origin : 'manual';
}

/** "Manual", or for a Todo made from a Block, its Daily Note's day: "Daily Note · 3 Oct". */
export function originLabel(todo: Item, madeFrom?: MadeFrom): string {
  const label = ORIGIN_LABELS[originOf(todo)];
  if (!madeFrom) return label;
  const [, month, date] = madeFrom.day.split('-').map(Number) as [number, number, number];
  return `${label} · ${date} ${MONTHS[month - 1]}`;
}
