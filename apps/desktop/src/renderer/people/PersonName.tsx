import { usePeople } from './context';
import { shownAs } from './people';

/**
 * Someone a Source names by `handle`, shown as their Person: the Person's name, with every handle
 * they have, by Source, on hover. While Commander doesn't know their Person, the Source's own name
 * (`fallback`). `you`: the User shows as "You". Where People have pages (#122), the name opens the
 * Person's page.
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
  const people = usePeople();
  const shown = shownAs(people, handle, fallback, { you });
  const person = shown.person;
  if (person && people.openPerson) {
    const open = people.openPerson;
    return (
      <button
        type="button"
        data-person={person.id}
        title={`${shown.title} · Open their page`}
        onClick={(event) => {
          // A name inside a row or a pane's control opens the Person, not what's around it.
          event.stopPropagation();
          open(person.id);
        }}
        className={`cursor-pointer border-0 bg-transparent p-0 text-left text-inherit [font:inherit] hover:underline ${className ?? ''}`}
      >
        {shown.name}
      </button>
    );
  }
  return (
    <span className={className} title={shown.title} data-person={person?.id}>
      {shown.name}
    </span>
  );
}
