import type { Item } from '@commander/domain';
import { useMemo } from 'react';
import { requestReveal } from '../../frame/reveal';
import { itemChangesFromCore } from '../../item-store/changes';
import { useMeetingPreps } from '../../links/meeting-prep';
import { type SectionDefinition, useOpenSection, useSection } from '../section';
import { sectionFor } from '../todos/links';
import { useDashboard } from './context';
import { DashboardSheet } from './DashboardSheet';
import { RowPrepContext, type RowPreps } from './RowPrep';

// The Dashboard Section: "What needs you", one ranked list merged from Todos and Linear. Its state
// (the Items, the ranking, the cleared rows) lives in the frame's <DashboardProvider> (context.tsx),
// which the header's band meter and the Project pages read too. The meetings' rows show Ares's prep
// for them (#130).
function DashboardSection() {
  const { rows } = useDashboard();
  const { active } = useSection();
  const openSection = useOpenSection();
  const eventIds = useMemo(
    () => rows.flatMap((row) => (row.item.kind === 'event' ? [row.item.id] : [])),
    [rows],
  );
  const preps = useMeetingPreps(window.commander.itemStore, eventIds, {
    changes: itemChangesFromCore,
    active,
  });
  const value = useMemo<RowPreps>(
    () => ({
      preps,
      openSource(item: Item) {
        const section = sectionFor(item.kind);
        if (!section) return;
        requestReveal(section, item.id);
        openSection(section);
      },
    }),
    [preps, openSection],
  );
  return (
    <RowPrepContext.Provider value={value}>
      <DashboardSheet />
    </RowPrepContext.Provider>
  );
}

export const dashboard: SectionDefinition = {
  id: 'dashboard',
  label: 'Dashboard',
  code: 'DSH',
  Component: DashboardSection,
};
