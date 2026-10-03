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
  className,
  ...props
}: ProjectFilterBarProps) {
  const numbered = Math.min(projects.length, 9);
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
        />
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
          'flex items-center gap-1.5 px-3.5 font-mono text-label leading-none font-medium uppercase tracking-label whitespace-nowrap [&_kbd]:h-4 [&_kbd]:min-w-4 [&_kbd]:text-tiny',
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
}: {
  keyCap?: string;
  badge?: ReactNode;
  label: string;
  title?: string;
  count: number;
  on: boolean;
  armed: boolean;
  onClick: () => void;
}) {
  return (
    <span className="flex border-r border-line2">
      <button
        type="button"
        aria-pressed={on}
        title={title}
        onClick={onClick}
        className={cn(
          'flex cursor-pointer items-center gap-[9px] border-0 px-3 font-mono text-label-lg leading-none font-semibold uppercase tracking-label whitespace-nowrap',
          on ? 'bg-ink text-sheet' : 'bg-transparent hover:bg-raise hover:text-ink',
          !on && (count ? 'text-muted' : 'text-faint'),
        )}
      >
        {keyCap && (
          <Kbd
            className={cn(
              'h-[15px] min-w-[15px] border-current px-[3px] text-tiny text-current',
              armed ? 'inline-flex' : 'hidden',
            )}
          >
            {keyCap}
          </Kbd>
        )}
        {badge}
        {label}
        <b className={cn('font-medium tabular-nums', on ? 'text-sheet opacity-70' : 'text-faint')}>
          {pad(count)}
        </b>
      </button>
    </span>
  );
}
