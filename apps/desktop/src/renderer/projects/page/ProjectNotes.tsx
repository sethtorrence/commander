import type { Project, ProjectBlock } from '@commander/domain';
import { Badge, toast } from '@commander/ui';
import { useEffect, useState } from 'react';
import { requestReveal } from '../../frame/reveal';
import type { ItemStoreClient } from '../../item-store/client';
import { dateOf, weekday } from '../../sections/notes/days';
import { SideCard } from './SideCard';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "Sat 3 Oct" */
const shortDay = (day: string) =>
  `${weekday(day).slice(0, 3)} ${dateOf(day).getDate()} ${MONTHS[dateOf(day).getMonth()]}`;

/** The Project's written Blocks (own or inherited), newest day first, read again with `reloadWhen`. */
function useProjectBlocks(itemStore: ItemStoreClient, projectId: string, reloadWhen: unknown) {
  const [blocks, setBlocks] = useState<ProjectBlock[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reloadWhen` asks for a reload after a change
  useEffect(() => {
    let current = true;
    itemStore({ op: 'project-blocks', projectId }).then(
      (found) => current && setBlocks(found),
      (error: unknown) => toast(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      current = false;
    };
  }, [itemStore, projectId, reloadWhen]);
  return blocks;
}

/**
 * A Project page's Notes (#51): the Blocks filed under the Project, by their own `#LT` or under a
 * Block that has it, grouped by day (.dnm in the prototype's "Daily Note · mentions" card). Each one
 * opens Notes at its Block, highlighted.
 */
export function ProjectNotes({
  project,
  itemStore,
  reloadWhen,
  onOpenSection,
}: {
  project: Project;
  itemStore: ItemStoreClient;
  reloadWhen: unknown;
  onOpenSection: (sectionId: string) => void;
}) {
  const blocks = useProjectBlocks(itemStore, project.id, reloadWhen);
  const days = [...new Set(blocks.map(({ day }) => day))];
  const open = (blockId: string) => {
    requestReveal('notes', blockId);
    onOpenSection('notes');
  };
  return (
    <SideCard
      label="Notes filed here"
      title={
        <>
          <Badge size="sm" code={project.code} accent={project.accent} project={project.name} />
          Notes · by day
        </>
      }
      note={pad(blocks.length)}
    >
      {days.map((day) => (
        <section key={day} aria-label={shortDay(day)}>
          <h3 className="m-0 px-2.5 pt-2 pb-[3px] font-mono text-tiny leading-[1.4] font-semibold uppercase tracking-caps text-muted">
            {shortDay(day)}
          </h3>
          {blocks
            .filter((found) => found.day === day)
            .map(({ block }) => (
              <button
                key={block.id}
                type="button"
                title="Open in Notes"
                onClick={() => open(block.id)}
                className="block w-full cursor-pointer border-0 border-b border-line2 bg-transparent px-2.5 pt-1.5 pb-2 text-left text-note leading-[18px] text-text hover:bg-raise"
              >
                {block.title}
              </button>
            ))}
        </section>
      ))}
      {!blocks.length && (
        <p className="m-0 px-2.5 pt-1.5 pb-2.5 text-note leading-[17px] text-faint">
          Nothing in the Daily Notes is filed under {project.name}. Tag a Block with #{project.code}.
        </p>
      )}
    </SideCard>
  );
}
