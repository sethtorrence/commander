import { EmptySheet, type SectionDefinition, SectionSheet } from '../section';

// The Ares Section: an empty sheet until its own ticket fills it in.
function AresSection() {
  return (
    <SectionSheet span="full" subtitle="Conversations with Ares, several at once">
      <EmptySheet>No Conversations yet.</EmptySheet>
    </SectionSheet>
  );
}

export const ares: SectionDefinition = {
  id: 'ares',
  label: 'Ares',
  code: 'ARS',
  Component: AresSection,
};
