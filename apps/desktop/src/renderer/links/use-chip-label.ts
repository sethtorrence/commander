import { useMemo } from 'react';
import { useProjectsIfAny } from '../projects/context';
import { dayKey } from '../sections/notes/days';
import { chipLabel, type LabelChip } from './block-text';

/**
 * How chips read here: Projects by their current name and Badge, days as "Fri 2 Oct" (with the year
 * when it isn't this one, which is all that today is needed for).
 */
export function useChipLabel(): LabelChip {
  const projects = useProjectsIfAny();
  return useMemo(() => {
    const byId = new Map(
      [...(projects?.projects ?? []), ...(projects?.archived ?? [])].map((p) => [p.id, p]),
    );
    const today = dayKey(new Date());
    return (target) => chipLabel(target, { today, projectById: (id) => byId.get(id) });
  }, [projects]);
}
