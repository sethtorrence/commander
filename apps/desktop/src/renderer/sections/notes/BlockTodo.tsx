import './block-todos.css';
import { CheckIcon } from '@commander/ui';
import { requestReveal } from '../../frame/reveal';
import { useOpenSection } from '../section';
import type { Notebook } from './notebook';
import type { Block } from './outline';

/*
  A Todo Block's parts beside its text (block-todos.ts): the checkbox in place of its bullet, which
  ticks the Todo, and the Todo tag after the text, the backlink to the Todo, which opens it in the
  Todos Section. After the prototype's .check and .pill (round-3/industrial.html).
*/

export function TodoCheck({ notebook, day, block }: { notebook: Notebook; day: string; block: Block }) {
  const done = !!block.todo?.done;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a checkbox input would take the caret from the Block's text
    <button
      type="button"
      className="n-check"
      tabIndex={-1}
      role="checkbox"
      aria-checked={done}
      aria-label={done ? 'Untick the Todo' : 'Tick the Todo'}
      title={done ? 'Ticked. Click to untick.' : 'Click to tick'}
      // The caret stays where it is in the text.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => notebook.tick(day, block.id)}
    >
      <span className="n-box">
        <CheckIcon />
      </span>
    </button>
  );
}

export function TodoTag({ block }: { block: Block }) {
  const openSection = useOpenSection();
  const todoId = block.todo?.id;
  if (!todoId) return null;
  return (
    <button
      type="button"
      className="n-pill"
      tabIndex={-1}
      title="Made into a Todo. Click to open it in Todos."
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        requestReveal('todos', todoId);
        openSection('todos');
      }}
    >
      Todo
    </button>
  );
}
