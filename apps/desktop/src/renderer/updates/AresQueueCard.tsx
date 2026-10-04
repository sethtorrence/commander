import { Kbd, Led } from '@commander/ui';
import { SideCard } from '../projects/page/SideCard';
import { useUpdates } from './context';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Ares's queue in the Dashboard's side column: the quiet count and Ask for an update. A count is
 * never an interruption: the Update opens only when the User asks.
 */
export function AresQueueCard() {
  const { queued, presence, ask } = useUpdates();
  const here = !presence || presence.state === 'active';
  return (
    <SideCard
      label="Ares’s queue"
      title="Ares’s queue"
      note={<span data-testid="ares-queue-count">{pad(queued)}</span>}
    >
      <p className="m-0 flex items-center gap-2 px-3 py-2.5 text-small leading-[18px] text-text">
        <Led size="sm" state={here ? 'on' : 'off'} />
        {queued
          ? `Ares has ${queued} thing${queued === 1 ? '' : 's'} for you.`
          : 'Ares has nothing for you right now.'}
      </p>
      <button
        type="button"
        onClick={ask}
        className="flex h-9 w-full cursor-pointer items-center justify-between border-0 border-t border-line2 bg-transparent pr-2.5 pl-3 font-mono text-label-lg leading-none font-semibold uppercase tracking-caps text-ink hover:bg-raise"
      >
        <span>Ask for an update</span>
        <Kbd>U</Kbd>
      </button>
    </SideCard>
  );
}
