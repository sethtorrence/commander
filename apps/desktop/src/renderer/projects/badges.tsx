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

type FilterBarProps = ComponentProps<typeof ProjectFilterBar>;

/**
 * The Project filter bar for a Section, under its sheet header: the app-wide filter, with the
 * Section's own counts, and each Project's page a click away. `items` are the Items the counts are
 * over (a Section's open Todos, say), unless the Section counts for itself (`counts`: Notes counts
 * Daily Notes).
 */
export function SectionProjectFilter({
  items = [],
  counts: own,
  ...props
}: {
  items?: readonly Pick<Item, 'filing'>[];
  counts?: ReturnType<typeof countByFilter>;
} & Omit<FilterBarProps, 'projects' | 'everything' | 'unfiled' | 'selected' | 'onSelect'> &
  Partial<Pick<FilterBarProps, 'selected' | 'onSelect'>>) {
  const { projects, filter, setFilter, openPage } = useProjects();
  const armed = usePendingKeys() === 'p';
  const counts = own ?? countByFilter(items);
  return (
    <ProjectFilterBar
      projects={projects.map((project) => ({ ...project, count: counts.project(project.id) }))}
      everything={counts.everything}
      unfiled={counts.unfiled}
      selected={filter}
      onSelect={setFilter}
      onOpenPage={openPage}
      armed={armed}
      {...props}
    />
  );
}
