import {
  type HandleSource,
  normaliseHandle,
  type PeopleAction,
  type PeopleChange,
  type Person,
  peopleByHandle,
} from '@commander/domain';
import type { ItemStoreClient } from '../item-store/client';

/*
  People in the window (#117): everyone Commander knows, from the Core, and the small resolver rows
  and detail panes use to show a handle (`linear:<id>`, `github:<login>`, `teams:<id>`, an address)
  as the Person it belongs to. Pure, so components and their tests share it.
*/

/** The window's People channel: the list, and the User's changes (each in the People log). */
export interface PeopleClient {
  list(): Promise<Person[]>;
  change(action: PeopleAction): Promise<PeopleChange>;
}

export function peopleIn(itemStore: ItemStoreClient): PeopleClient {
  return {
    list: () => itemStore({ op: 'people' }),
    change: (action) => itemStore({ op: 'change-people', action }),
  };
}

/** Handle → Person, for showing names. Knows no one until People load (or with no provider). */
export interface PeopleLookup {
  /** The Person a handle belongs to, if Commander knows them. */
  personOf(handle: string): Person | undefined;
}

export const NO_PEOPLE: PeopleLookup = { personOf: () => undefined };

export function lookupOf(people: readonly Person[]): PeopleLookup {
  const byHandle = peopleByHandle(people);
  return { personOf: (handle) => byHandle.get(normaliseHandle(handle)) };
}

const SOURCE_NAMES: Record<HandleSource, string> = {
  linear: 'Linear',
  github: 'GitHub',
  teams: 'Teams',
  email: 'Email',
  other: 'Other',
};

/** "Linear", "GitHub", "Teams", "Email": where a handle comes from, as the User reads it. */
export const handleSourceName = (source: HandleSource) => SOURCE_NAMES[source];

/** A handle as the User reads it: a GitHub login as `@login`, an address as it is, other ids bare. */
export function handleLabel(handle: { handle: string; source: HandleSource; name: string | null }): string {
  const bare = handle.handle.slice(handle.handle.indexOf(':') + 1);
  switch (handle.source) {
    case 'github':
      return `@${bare}`;
    case 'email':
      return handle.handle;
    default:
      return handle.name ?? bare;
  }
}

/** A Person's handles on one line, by Source: the hover text wherever a Person's name is shown. */
export function handlesLine(person: Person): string {
  return person.handles.map((each) => `${handleSourceName(each.source)}: ${handleLabel(each)}`).join(' · ');
}

/**
 * How to show someone a Source names by `handle`: their Person's name (or "You" for the User, when
 * `you` is asked for), with their handles for the hover text; the Source's own name for them when
 * Commander doesn't know their Person yet.
 */
export function shownAs(
  lookup: PeopleLookup,
  handle: string,
  fallback: string,
  options: { you?: boolean } = {},
): { name: string; title: string; person: Person | undefined } {
  const person = lookup.personOf(handle);
  if (!person) return { name: fallback, title: fallback, person };
  const name = options.you && person.isUser ? 'You' : person.name;
  return { name, title: `${person.name} — ${handlesLine(person)}`, person };
}

/** Whether every word typed starts a word of the Person's name, or the text starts one of their handles. */
export function personMatches(person: Person, text: string): boolean {
  const typed = text.trim().toLowerCase();
  if (!typed) return true;
  const words = person.name.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  const byName = typed.split(/\s+/).every((word) => words.some((each) => each.startsWith(word)));
  return (
    byName ||
    person.handles.some(({ handle }) => {
      const bare = handle.slice(handle.indexOf(':') + 1).toLowerCase();
      return handle.toLowerCase().startsWith(typed) || bare.startsWith(typed);
    })
  );
}
