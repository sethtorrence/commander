import type { SectionDefinition } from '../section';
import { DashboardSheet } from './DashboardSheet';

// The Dashboard Section: "What needs you", one ranked list merged from Todos and Linear. Its state
// (the Items, the ranking, the cleared rows) lives in the frame's <DashboardProvider> (context.tsx),
// which the header's band meter and the Project pages read too.
export const dashboard: SectionDefinition = {
  id: 'dashboard',
  label: 'Dashboard',
  code: 'DSH',
  Component: DashboardSheet,
};
