import { goneNote, kindTag, linkLabel } from '../links';
import type { TodoLink } from '../todos';
import { KindTag, PaneEmpty, PanePart } from './parts';

/** The Todo's Links both ways (.rel): each one opens the Item at its other end. */
export function TodoLinks({ links, onOpen }: { links: TodoLink[]; onOpen: (link: TodoLink) => void }) {
  return (
    <PanePart label="Links" count={links.length}>
      {links.length ? (
        links.map((link) => {
          const gone = goneNote(link.other);
          return (
            <button
              key={`${link.backlink ? 'to' : 'from'}:${link.type}:${link.other.id}`}
              type="button"
              disabled={!!gone}
              onClick={() => onOpen(link)}
              className="flex min-h-[34px] w-full cursor-pointer items-center gap-2.5 border border-t-0 border-line bg-transparent px-2.5 py-1.5 text-left text-heading leading-[18px] text-text first-of-type:border-t hover:bg-raise hover:text-ink disabled:cursor-default disabled:hover:bg-transparent"
            >
              <KindTag>{kindTag(link.other.kind)}</KindTag>
              <span className="min-w-0 flex-1">
                <span className="mr-1.5 font-mono text-label font-medium uppercase tracking-tag text-muted">
                  {linkLabel(link)}
                </span>
                <span className={gone ? 'text-faint line-through decoration-1' : undefined}>
                  {link.other.title}
                </span>
                {gone && <span className="ml-1.5 text-note text-faint">{gone}</span>}
              </span>
            </button>
          );
        })
      ) : (
        <PaneEmpty>No Links yet.</PaneEmpty>
      )}
    </PanePart>
  );
}
