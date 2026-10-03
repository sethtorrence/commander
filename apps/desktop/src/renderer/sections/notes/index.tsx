import { EmptySheet, type SectionDefinition, SectionSheet } from '../section';

// The Notes Section: an empty sheet until its own ticket fills it in.
function NotesSection() {
  return (
    <SectionSheet span="full" subtitle="One Daily Note for each day">
      <EmptySheet>No Daily Notes yet.</EmptySheet>
    </SectionSheet>
  );
}

export const notes: SectionDefinition = {
  id: 'notes',
  label: 'Notes',
  headerTitle: 'Daily Notes',
  code: 'DN',
  Component: NotesSection,
};
