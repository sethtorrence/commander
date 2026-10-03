import { useMemo } from 'react';
import { itemChangesFromCore } from '../../item-store/changes';
import type { SectionDefinition } from '../section';
import { TodosSheet } from './TodosSheet';
import { todosIn } from './todos';

// The Todos Section: the User's Todos, listed, opened into a detail pane, edited, ticked and
// deleted. It talks to the Item store only through the Todos module (todos.ts), via the window's
// bridge.
function TodosSection() {
  const todos = useMemo(() => todosIn(window.commander.itemStore), []);
  return <TodosSheet todos={todos} changes={itemChangesFromCore} />;
}

export const todos: SectionDefinition = {
  id: 'todos',
  label: 'Todos',
  code: 'TDO',
  Component: TodosSection,
};
