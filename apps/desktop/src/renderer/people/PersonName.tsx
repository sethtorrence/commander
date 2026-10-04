import { usePeople } from './context';
import { shownAs } from './people';

/**
 * Someone a Source names by `handle`, shown as their Person: the Person's name, with every handle
 * they have, by Source, on hover. While Commander doesn't know their Person, the Source's own name
 * (`fallback`). `you`: the User shows as "You".
 */
export function PersonName({
  handle,
  fallback,
  you = false,
  className,
}: {
  handle: string;
  fallback: string;
  you?: boolean;
  className?: string;
}) {
  const shown = shownAs(usePeople(), handle, fallback, { you });
  return (
    <span className={className} title={shown.title} data-person={shown.person?.id}>
      {shown.name}
    </span>
  );
}
