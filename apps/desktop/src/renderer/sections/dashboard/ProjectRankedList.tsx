import { requestReveal } from '../../frame/reveal';
import { PickBadgeProvider, useBadgePicker } from '../../projects/BadgePicker';
import { useDashboardIfAny } from './context';
import { openIn, RankedList, revealId, useFeedSelection } from './RankedList';

/**
 * The Dashboard's ranked list scoped to one Project, for its Project page: the same bands, rows and
 * reasons, worked with the mouse (a row's bar ticks, opens or clears it; its Badge files it). The
 * page's keys stay with its open Todos. Nothing where there is no Dashboard (a component test).
 */
export function ProjectRankedList({
  projectId,
  projectName,
  onOpenSection,
}: {
  projectId: string;
  projectName: string;
  /** Opens a Section; the row's Item is then shown there, selected and opened (frame/reveal.ts). */
  onOpenSection: (sectionId: string) => void;
}) {
  const dashboard = useDashboardIfAny();
  const rows = (dashboard?.rows ?? []).filter((row) => row.item.filing?.projectId === projectId);
  const selection = useFeedSelection(rows);
  const noop = async () => null;
  const badges = useBadgePicker(dashboard?.apply ?? noop, (entryId) => void dashboard?.undo(entryId));
  if (!dashboard) return null;
  return (
    <section aria-label={`Ranked for you in ${projectName}`} className="mb-5.5 [&+section>h2]:border-t">
      <PickBadgeProvider value={badges.open}>
        <RankedList
          rows={rows}
          selectedId={selection.selected?.item.id ?? null}
          now={dashboard.rankedAt.getTime()}
          empty={`Nothing for ${projectName} in this band.`}
          onSelect={(row) => selection.select(row.item.id)}
          onOpen={(row) => {
            const section = openIn(row);
            if (!section) return;
            onOpenSection(section[0]);
            requestReveal(section[0], revealId(row), row.focus?.messageId);
          }}
          onTick={(row) => void dashboard.tick(row)}
          onClear={dashboard.clear}
          onSettle={(row, op) => void dashboard.settleSuggestion(row, op)}
        />
      </PickBadgeProvider>
      {badges.picker}
    </section>
  );
}
