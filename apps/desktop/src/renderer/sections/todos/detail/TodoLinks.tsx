import { labelBlockLinks } from '@commander/domain';
import { useChipLabel } from '../../../links/use-chip-label';
import { goneNote, kindTag, linkLabel } from '../links';
import type { TodoLink } from '../todos';
import { KindTag, PaneEmpty, PanePart } from './parts';

/**
 * The Todo's Links both ways (.rel): each one opens the Item at its other end. With `onRemove`, the
 * Links it allows (`removable`) have a Remove button beside them.
 */
export function TodoLinks({
  links,
  onOpen,
  onRemove,
  removable = () => true,
}: {
  links: TodoLink[];
  onOpen: (link: TodoLink) => void;
  onRemove?: (link: TodoLink) => void;
  removable?: (link: TodoLink) => boolean;
}) {
  // A Block's title keeps its `[[` tokens (a meeting chip's is one): they read as their chips do.
  const label = useChipLabel();
  return (
    <PanePart label="Links" count={links.length}>
      {links.length ? (
        links.map((link) => {
          const gone = goneNote(link.other);
          const key = `${link.backlink ? 'to' : 'from'}:${link.type}:${link.other.id}`;
          const row = (
            <button
              key={key}
              type="button"
              disabled={!!gone}
              onClick={() => onOpen(link)}
              className={
                onRemove
                  ? 'flex min-h-[34px] min-w-0 flex-1 cursor-pointer items-center gap-2.5 border-0 bg-transparent px-2.5 py-1.5 text-left text-heading leading-[18px] text-text hover:bg-raise hover:text-ink disabled:cursor-default disabled:hover:bg-transparent'
                  : 'flex min-h-[34px] w-full cursor-pointer items-center gap-2.5 border border-t-0 border-line bg-transparent px-2.5 py-1.5 text-left text-heading leading-[18px] text-text first-of-type:border-t hover:bg-raise hover:text-ink disabled:cursor-default disabled:hover:bg-transparent'
              }
            >
              <KindTag>{kindTag(link.other.kind)}</KindTag>
              <span className="min-w-0 flex-1">
                <span className="mr-1.5 font-mono text-label font-medium uppercase tracking-tag text-muted">
                  {linkLabel(link)}
                </span>
                <span className={gone ? 'text-faint line-through decoration-1' : undefined}>
                  {labelBlockLinks(link.other.title, (target) => label(target).text)}
                </span>
                {gone && <span className="ml-1.5 text-note text-faint">{gone}</span>}
              </span>
            </button>
          );
          if (!onRemove) return row;
          return (
            <div key={key} className="flex items-stretch border border-t-0 border-line first:border-t">
              {row}
              {removable(link) && (
                <button
                  type="button"
                  aria-label={`Remove the Link: ${linkLabel(link)} ${link.other.title}`}
                  onClick={() => onRemove(link)}
                  className="cursor-pointer border-0 border-l border-line2 bg-transparent px-2.5 font-mono text-label leading-none font-medium uppercase tracking-label text-muted hover:bg-raise hover:text-ink"
                >
                  Remove
                </button>
              )}
            </div>
          );
        })
      ) : (
        <PaneEmpty>No Links yet.</PaneEmpty>
      )}
    </PanePart>
  );
}
