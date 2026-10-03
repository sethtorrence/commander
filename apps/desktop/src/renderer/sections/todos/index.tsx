import { EmptySheet, type SectionDefinition, SectionSheet } from '../section';

// The Todos Section: an empty sheet until its own ticket fills it in.
function TodosSection() {
  return (
    <SectionSheet span="wide" subtitle="From Linear, Email, the Daily Note and you">
      <EmptySheet>No Todos yet.</EmptySheet>
    </SectionSheet>
  );
}

export const todos: SectionDefinition = {
  id: 'todos',
  label: 'Todos',
  code: 'TDO',
  Component: TodosSection,
};
