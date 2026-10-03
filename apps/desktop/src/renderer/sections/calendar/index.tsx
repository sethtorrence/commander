import { EmptySheet, type SectionDefinition, SectionSheet } from '../section';

// The Calendar Section: an empty sheet until its own ticket fills it in.
function CalendarSection() {
  return (
    <SectionSheet span="full" subtitle="Today's schedule and what comes next">
      <EmptySheet>No calendar Accounts connected yet.</EmptySheet>
    </SectionSheet>
  );
}

export const calendar: SectionDefinition = {
  id: 'calendar',
  label: 'Calendar',
  code: 'CAL',
  Component: CalendarSection,
};
