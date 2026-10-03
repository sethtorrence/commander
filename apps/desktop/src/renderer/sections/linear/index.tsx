import { EmptySheet, type SectionDefinition, SectionSheet } from '../section';

// The Linear Section: an empty sheet until its own ticket fills it in.
function LinearSection() {
  return (
    <SectionSheet span="full" subtitle="Linear issues assigned to you">
      <EmptySheet>No Linear Account connected yet.</EmptySheet>
    </SectionSheet>
  );
}

export const linear: SectionDefinition = {
  id: 'linear',
  label: 'Linear',
  code: 'LIN',
  Component: LinearSection,
};
