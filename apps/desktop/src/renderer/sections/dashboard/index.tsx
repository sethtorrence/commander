import { EmptySheet, type SectionDefinition, SectionSheet } from '../section';

// The Dashboard Section: an empty sheet until its own ticket fills it in.
function DashboardSection() {
  return (
    <SectionSheet span="wide" title="What needs you" size="dashboard" subtitle="Ranked from every Section">
      <EmptySheet>
        Nothing needs you yet. Once Sources are connected, what needs you from every Section is ranked here.
      </EmptySheet>
    </SectionSheet>
  );
}

export const dashboard: SectionDefinition = {
  id: 'dashboard',
  label: 'Dashboard',
  code: 'DSH',
  Component: DashboardSection,
};
