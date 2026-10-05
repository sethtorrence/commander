import { usePeople } from './context';

/**
 * A Person's page's temporary notebook tab (#122), after the Project page's (.tab.ptab): their name,
 * and × to close it. It stays while the page is open, so the User can step into a Section and back.
 */
export function PersonPageTab({
  personId,
  current,
  onOpen,
  onClose,
}: {
  personId: string;
  current: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const person = usePeople().people.find((each) => each.id === personId);
  const name = person?.name ?? 'Person';
  return (
    <div
      className="f-tab temp"
      data-section="person-page"
      aria-current={current ? 'page' : undefined}
      title={`${name} · Person · Esc closes`}
    >
      <button
        type="button"
        aria-label={`${name}’s page`}
        onClick={onOpen}
        className="flex min-w-0 cursor-pointer items-center gap-[9px] border-0 bg-transparent p-0 text-inherit"
      >
        <span
          aria-hidden="true"
          className="grid h-[19px] w-[22px] flex-none place-items-center border border-current font-mono text-[9px] leading-none font-bold"
        >
          {initials(name)}
        </span>
        <span className="tlb">{name}</span>
      </button>
      <button type="button" className="tx" aria-label={`Close ${name}’s page`} onClick={onClose}>
        ×
      </button>
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
