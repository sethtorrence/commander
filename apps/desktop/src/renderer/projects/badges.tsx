import type { Filing, FilingSuggestion, Item } from '@commander/domain';
import { accentColour, Badge, type BadgeProps, ProjectFilterBar, SuggestedFiling } from '@commander/ui';
import type { ComponentProps } from 'react';
import { usePendingKeys } from '../shortcuts/react';
import { type PickerTarget, usePickBadge } from './BadgePicker';
import { useProjects } from './context';
import { countByFilter } from './filter';

/**
 * An Item's Badge: its Project's code on the Project's accent, or a faint `—` when Unfiled. An
 * Unfiled Item Ares suggested a Project for wears that Project's dashed Badge until the User answers.
 */
export function ItemBadge({
  filing,
  suggestion,
  ...props
}: { filing: Filing; suggestion?: FilingSuggestion } & Omit<BadgeProps, 'code' | 'accent'>) {
  const { projectOf, projectById } = useProjects();
  const project = projectOf(filing);
  const suggested = !filing && suggestion ? projectById(suggestion.projectId) : undefined;
  if (suggested)
    return (
      <Badge
        kind="suggested"
        code={suggested.code}
        accent={suggested.accent}
        project={suggested.name}
        {...props}
      />
    );
  if (!project) return <Badge kind="unfiled" {...props} />;
  return <Badge code={project.code} accent={project.accent} project={project.name} {...props} />;
}

/** Ares's filing suggestion an Item is waiting on: none once it is filed (the User or a Rule won). */
export const waitingSuggestion = (item: Pick<Item, 'filing' | 'filingSuggestion'>) =>
  item.filing ? undefined : item.filingSuggestion;

/**
 * A detail pane's Project line: the Item's Badge and its Project's name (or Unfiled), or, while Ares's
 * suggestion waits, the dashed Badge with Confirm and Change (the Section's Badge picker).
 */
export function ItemProject({ item }: { item: PickerTarget }) {
  const { projectOf, projectById } = useProjects();
  const pick = usePickBadge();
  const suggestion = item.filing ? undefined : item.filingSuggestion;
  const suggested = suggestion ? projectById(suggestion.projectId) : undefined;
  if (suggested && pick)
    return (
      <SuggestedFiling
        data-testid="suggested-filing"
        code={suggested.code}
        accent={suggested.accent}
        project={suggested.name}
        onConfirm={() => pick.confirm?.(item)}
        onChange={() => pick(item)}
      />
    );
  const project = projectOf(item.filing);
  return (
    <span className="flex items-center justify-end gap-[9px]">
      <ItemBadge filing={item.filing} suggestion={suggestion} />
      {project ? project.name : 'Unfiled'}
    </span>
  );
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
