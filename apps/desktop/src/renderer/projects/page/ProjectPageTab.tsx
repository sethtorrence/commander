import { Badge } from '@commander/ui';
import { useProjects } from '../context';

/**
 * A Project page's temporary notebook tab, after the numbered ones (.tab.ptab): its Badge and name,
 * and × to close it. It stays while the page is open, so the User can step into a Section and back.
 */
export function ProjectPageTab({
  projectId,
  current,
  onOpen,
  onClose,
}: {
  projectId: string;
  current: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const project = useProjects().projectById(projectId);
  if (!project) return null;
  return (
    // A div, so the close button isn't nested in another button.
    <div
      className="f-tab temp"
      data-section="project-page"
      aria-current={current ? 'page' : undefined}
      title={`${project.name} · Project page · Esc closes`}
    >
      <button
        type="button"
        aria-label={`${project.name} page`}
        onClick={onOpen}
        className="flex min-w-0 cursor-pointer items-center gap-[9px] border-0 bg-transparent p-0 text-inherit"
      >
        <Badge
          code={project.code}
          accent={project.accent}
          project={project.name}
          className="h-[19px] w-[22px]"
        />
        <span className="tlb">{project.name}</span>
      </button>
      <button type="button" className="tx" aria-label={`Close the ${project.name} page`} onClick={onClose}>
        ×
      </button>
    </div>
  );
}
