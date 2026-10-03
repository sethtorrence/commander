import type { Filing, Item } from '@commander/domain';
import { accentColour, Badge, type BadgeProps, ProjectFilterBar } from '@commander/ui';
import type { ComponentProps } from 'react';
import { usePendingKeys } from '../shortcuts/react';
import { useProjects } from './context';
import { countByFilter } from './filter';

/** An Item's Badge: its Project's code on the Project's accent, or a faint `—` when Unfiled. */
export function ItemBadge({ filing, ...props }: { filing: Filing } & Omit<BadgeProps, 'code' | 'accent'>) {
  const project = useProjects().projectOf(filing);
  if (!project) return <Badge kind="unfiled" {...props} />;
  return <Badge code={project.code} accent={project.accent} project={project.name} {...props} />;
}

/**
 * The colour of a row's thin left bar (the Project's accent), or undefined when Unfiled. Accents
 * appear only as Badges and these bars.
 */
export function useAccentBar(filing: Filing): string | undefined {
  const project = useProjects().projectOf(filing);
  return project && accentColour(project.accent);
}

/**
 * The Project filter bar for a Section, under its sheet header: the app-wide filter, with the
 * Section's own counts. `items` are the Items the counts are over (a Section's open Todos, say).
 */
export function SectionProjectFilter({
  items,
  ...props
}: { items: readonly Pick<Item, 'filing'>[] } & Omit<
  ComponentProps<typeof ProjectFilterBar>,
  'projects' | 'everything' | 'unfiled' | 'selected' | 'onSelect'
>) {
  const { projects, filter, setFilter } = useProjects();
  const armed = usePendingKeys() === 'p';
  const counts = countByFilter(items);
  return (
    <ProjectFilterBar
      projects={projects.map((project) => ({ ...project, count: counts.project(project.id) }))}
      everything={counts.everything}
      unfiled={counts.unfiled}
      selected={filter}
      onSelect={setFilter}
      armed={armed}
      {...props}
    />
  );
}
