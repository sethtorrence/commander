import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Badge } from './badge';
import { Kbd } from './marks';

/** What the Project filter shows: everything, the Unfiled Items, or one Project (by its id). */
export type ProjectFilterValue = 'everything' | 'unfiled' | (string & {});

export interface ProjectFilterProject {
  id: string;
  code: string;
  name: string;
  /** A palette accent name, or any CSS colour. */
  accent: string;
  /** How many of the Section's Items are in this Project. */
  count: number;
}

export type ProjectFilterBarProps = Omit<ComponentProps<'div'>, 'onSelect'> & {
  /** The Projects in their order; the first nine get the number keys after `p`. */
  projects: readonly ProjectFilterProject[];
  /** The Section's count for Everything, and for Unfiled. */
  everything: number;
  unfiled: number;
  selected: ProjectFilterValue;
  onSelect: (value: ProjectFilterValue) => void;
  /** `p` was pressed and waits for its second key: show which key picks which filter. */
  armed?: boolean;
  /**
   * Opens a Project's page. When given, each Project gets an open control (↗), a double-click on a
   * Project opens its page, and the selected Project's page is offered at the end of the bar.
   */
  onOpenPage?: (projectId: string) => void;
  /** The Project whose page this bar sits on, if any. */
  page?: string;
  /** On a Project page: the way back (the Section the User came from), with `Esc`. */
  back?: { label: string; onClick: () => void };
};

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The Project filter bar (.pflt in the prototypes): Everything · each Project · Unfiled, with the
 * Section's counts, under a Section's sheet header. It only draws the filter; the Section passes the
 * counts and the one app-wide selection.
 */
export function ProjectFilterBar({
  projects,
  everything,
  unfiled,
  selected,
  onSelect,
  armed = false,
  onOpenPage,
  page,
  back,
  className,
  ...props
}: ProjectFilterBarProps) {
  const numbered = Math.min(projects.length, 9);
  const selectedProject = projects.find((project) => project.id === selected);
  const end =
    'flex flex-none cursor-pointer items-center gap-[9px] border-0 border-l border-line bg-transparent px-3.5 font-mono text-label-lg leading-none font-semibold uppercase tracking-label whitespace-nowrap text-ink hover:bg-raise [&_kbd]:h-4 [&_kbd]:min-w-4 [&_kbd]:border-current [&_kbd]:text-tiny [&_kbd]:text-current';
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and form semantics
    <div
      role="group"
      aria-label="Project filter"
      data-slot="project-filter-bar"
      data-armed={armed || undefined}
      className={cn(
        'relative flex h-9 flex-none items-stretch border-b border-line bg-sheet',
        armed && 'shadow-[inset_0_-2px_0_var(--ink)]',
        className,
      )}
      {...props}
    >
      <span
        title="Project"
        className="grid w-[41px] flex-none place-items-center border-r border-line2 font-mono text-micro leading-none font-semibold tracking-label text-faint"
      >
        PRJ
      </span>
      <Option
        keyCap="0"
        label="Everything"
        count={everything}
        on={selected === 'everything'}
        armed={armed}
        onClick={() => onSelect('everything')}
      />
      {projects.map((project, index) => (
        <Option
          key={project.id}
          keyCap={index < 9 ? String(index + 1) : undefined}
          badge={<Badge code={project.code} accent={project.accent} project={project.name} />}
          label={project.name}
          title={`Only ${project.name}`}
          count={project.count}
          on={selected === project.id}
          armed={armed}
          onClick={() => onSelect(project.id)}
          onDoubleClick={onOpenPage && (() => onOpenPage(project.id))}
        >
          {onOpenPage && (
            <button
              type="button"
              aria-label={`Open the ${project.name} page`}
              title={`Open the ${project.name} page`}
              data-on={page === project.id || undefined}
              onClick={() => onOpenPage(project.id)}
              className={cn(
                'w-[26px] flex-none cursor-pointer border-0 border-l border-line2 bg-transparent p-0 font-mono text-[11px] leading-none font-semibold hover:bg-raise hover:text-ink',
                page === project.id ? 'text-ink shadow-[inset_0_-2px_0_var(--ink)]' : 'text-faint',
              )}
            >
              ↗
            </button>
          )}
        </Option>
      ))}
      <Option
        keyCap="U"
        badge={
          <Badge
            kind="unfiled"
            className={cn(selected === 'unfiled' && 'text-sheet shadow-[inset_0_0_0_1px_var(--sheet)]')}
          />
        }
        label="Unfiled"
        title="Only Items with no Project"
        count={unfiled}
        on={selected === 'unfiled'}
        armed={armed}
        onClick={() => onSelect('unfiled')}
      />
      <span className="flex-1" />
      <span
        className={cn(
          'flex items-center gap-1.5 px-3.5 font-mono text-label leading-none font-medium uppercase tracking-label whitespace-nowrap max-[1440px]:hidden [&_kbd]:h-4 [&_kbd]:min-w-4 [&_kbd]:text-tiny',
          armed ? 'text-ink' : 'text-faint',
        )}
      >
        {armed ? (
          <>
            <Kbd>0</Kbd>All
            {numbered > 0 && (
              <>
                <Kbd>1</Kbd>
                {numbered > 1 && (
                  <>
                    –<Kbd>{numbered}</Kbd>
                  </>
                )}
                Project
              </>
            )}
            <Kbd>U</Kbd>Unfiled
            {onOpenPage && (
              <>
                <Kbd>O</Kbd>Page
              </>
            )}
          </>
        ) : (
          <>
            <Kbd>P</Kbd>then
            {numbered > 0 ? (
              <>
                <Kbd>1</Kbd>
                {numbered > 1 && (
                  <>
                    –<Kbd>{numbered}</Kbd>
                  </>
                )}
              </>
            ) : (
              <Kbd>0</Kbd>
            )}
          </>
        )}
      </span>
      {back ? (
        <button type="button" onClick={back.onClick} title={`Back to ${back.label} (Esc)`} className={end}>
          {back.label}
          <Kbd>Esc</Kbd>
        </button>
      ) : (
        onOpenPage &&
        selectedProject && (
          <button
            type="button"
            onClick={() => onOpenPage(selectedProject.id)}
            className={cn(end, 'max-[1440px]:hidden')}
          >
            {selectedProject.name} page ↗
          </button>
        )
      )}
    </div>
  );
}

function Option({
  keyCap,
  badge,
  label,
  title,
  count,
  on,
  armed,
  onClick,
  onDoubleClick,
  children,
}: {
  keyCap?: string;
  badge?: ReactNode;
  label: string;
  title?: string;
  count: number;
  on: boolean;
  armed: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  /** Controls after the option, inside its cell (a Project's open control). */
  children?: ReactNode;
}) {
  return (
    // On a narrow sheet the names give way (cut short) before anything else does.
    <span className="flex min-w-0 border-r border-line2">
      <button
        type="button"
        aria-pressed={on}
        title={title}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        className={cn(
          'flex min-w-0 cursor-pointer items-center gap-[9px] border-0 px-3 font-mono text-label-lg leading-none font-semibold uppercase tracking-label whitespace-nowrap max-[1440px]:gap-[7px] max-[1440px]:px-2.5',
          on ? 'bg-ink text-sheet' : 'bg-transparent hover:bg-raise hover:text-ink',
          !on && (count ? 'text-muted' : 'text-faint'),
        )}
      >
        {keyCap && (
          <Kbd
            className={cn(
              'h-[15px] min-w-[15px] flex-none border-current px-[3px] text-tiny text-current',
              armed ? 'inline-flex' : 'hidden',
            )}
          >
            {keyCap}
          </Kbd>
        )}
        {badge}
        <span className="min-w-0 truncate">{label}</span>
        <b className={cn('flex-none font-medium tabular-nums', on ? 'text-sheet opacity-70' : 'text-faint')}>
          {pad(count)}
        </b>
      </button>
      {children}
    </span>
  );
}
