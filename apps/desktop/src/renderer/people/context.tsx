import type { PeopleAction, PeopleChange, Person } from '@commander/domain';
import { toast } from '@commander/ui';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ItemChanges } from '../item-store/changes';
import { lookupOf, NO_PEOPLE, type PeopleClient, type PeopleLookup } from './people';

/*
  People for the whole window: the frame mounts one <PeopleProvider>, and rows, detail panes, filters
  and Settings → People read it through `usePeople()`. Matching happens in the Core as Sources sync,
  so the People are read again (a moment later) whenever Items change; the User's own changes reload
  them at once. Without a provider (a Section's own tests), no one is known and Sources' names show.
*/

export interface PeopleApi extends PeopleLookup {
  /** Everyone Commander knows, the User first, then by name. Empty until loaded. */
  people: readonly Person[];
  /** Merges, splits, renames or undoes, then reloads. Rejects with the reason when refused. */
  change(action: PeopleAction): Promise<PeopleChange>;
  loaded: boolean;
  /** Opens a Person's page (#122) as a temporary tab; undefined where there are no pages. */
  openPerson?: (personId: string) => void;
}

const PeopleContext = createContext<PeopleApi | null>(null);

const NOBODY: PeopleApi = {
  ...NO_PEOPLE,
  people: [],
  change: () => Promise.reject(new Error('People aren’t available here')),
  loaded: false,
};

/** How long after Items change to read People again: one read for a burst of syncing. */
const RELOAD_DELAY_MS = 400;

export function PeopleProvider({
  client,
  changes,
  onOpenPerson,
  children,
}: {
  client: PeopleClient;
  changes?: ItemChanges;
  /** Shows a Person's page; the frame passes it. */
  onOpenPerson?: (personId: string) => void;
  children: ReactNode;
}) {
  const [all, setAll] = useState<Person[] | null>(null);

  const reload = useCallback(
    () =>
      client.list().then(setAll, (error: unknown) => {
        toast(error instanceof Error ? error.message : String(error));
      }),
    [client],
  );
  useEffect(() => {
    reload();
  }, [reload]);
  useEffect(() => {
    if (!changes) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = changes(() => {
      clearTimeout(timer);
      timer = setTimeout(reload, RELOAD_DELAY_MS);
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [changes, reload]);

  const api = useMemo<PeopleApi>(() => {
    const people = all ?? [];
    return {
      ...lookupOf(people),
      people,
      async change(action) {
        try {
          return await client.change(action);
        } finally {
          await reload();
        }
      },
      loaded: all !== null,
      ...(onOpenPerson && { openPerson: onOpenPerson }),
    };
  }, [all, client, reload, onOpenPerson]);

  return <PeopleContext.Provider value={api}>{children}</PeopleContext.Provider>;
}

/** The window's People; with no provider, no one is known (Sources' own names show). */
export function usePeople(): PeopleApi {
  return useContext(PeopleContext) ?? NOBODY;
}
