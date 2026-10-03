import type { Project } from '@commander/domain';
import { Badge, Kbd } from '@commander/ui';
import { type RefObject, useState } from 'react';

/** The New Todo field at the foot of the open list (.addrow): type a title and press Enter. */
export function AddTodo({
  input,
  add,
  project,
}: {
  input: RefObject<HTMLInputElement | null>;
  add: (title: string) => Promise<boolean>;
  /** The Project selected in the Project filter, which a new Todo is filed under. */
  project?: Project;
}) {
  const [title, setTitle] = useState('');
  return (
    <label className="flex items-center gap-2.5 border-b border-line2 py-2 pr-5 pl-13">
      <span className="grid w-6 flex-none place-items-center">
        <span className="size-3.5 border-[1.5px] border-dashed border-muted" />
      </span>
      <input
        ref={input}
        type="text"
        aria-label="New Todo"
        placeholder={project ? `New Todo in ${project.name}…` : 'New Todo…'}
        autoComplete="off"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={async (event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (await add(title)) setTitle('');
        }}
        className="h-7.5 min-w-0 flex-1 border-0 bg-transparent font-sans text-row leading-[30px] text-ink caret-signal outline-none placeholder:text-faint"
      />
      {project && <Badge code={project.code} accent={project.accent} project={project.name} />}
      <Kbd className="opacity-70">↵</Kbd>
    </label>
  );
}
