import './block-projects.css';
import type { Filing } from '@commander/domain';
import { cn } from '@commander/ui';
import { ItemBadge, useAccentBar } from '../../projects/badges';

/*
  A Block's Project in the sheet's numbered margin (#51): a Block with its own Project shows its
  Badge in place of its number, and its accent as a thin bar on the margin rule; the Blocks that
  inherit it carry the bar faintly, so a tagged parent visibly covers its children. The Badge opens
  the Badge picker (in the editor `b` is a typing key). Untagged Blocks show their number; pointing at
  it shows the Badge they would get (faint, or `—`) to click.
*/

export function BlockMargin({
  filing,
  own,
  label,
  onPick,
}: {
  /** The Project the Block shows (own or inherited), or null when Unfiled. */
  filing: Filing;
  /** Whether that is the Block's own Project. */
  own: boolean;
  /** The Block, for the Badge's accessible name. */
  label: string;
  onPick: (anchor: HTMLElement) => void;
}) {
  const bar = useAccentBar(filing);
  return (
    <>
      {bar && (
        <span
          aria-hidden="true"
          className={cn('n-pbar', !own && 'inherited')}
          style={{ background: bar }}
          data-testid="block-accent-bar"
        />
      )}
      <button
        type="button"
        tabIndex={-1}
        className={cn('n-mb', !own && 'ghost')}
        title={own ? 'Filed by you. Click to change the Project.' : 'Click to file under a Project'}
        aria-label={`Project of ${label || 'the Block'}`}
        data-testid="block-badge"
        data-own={own || undefined}
        // The caret stays where it is in the text.
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => onPick(event.currentTarget)}
      >
        <ItemBadge filing={filing} size="sm" />
      </button>
    </>
  );
}
