import type { PeopleAction, PeopleChange, Person } from '@commander/domain';
import { Button, cn, Input, toast } from '@commander/ui';
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useReveal } from '../frame/reveal';
import { errorText } from '../projects/change-with-undo';
import { SettingsGroup } from '../settings/parts';
import { type PeopleApi, usePeople } from './context';
import { handleLabel, handleSourceName, personMatches } from './people';

/*
  Settings → People (#117): everyone Commander knows, searchable, each with their handles by Source.
  Commander matches People across Sources by email address; where it got someone wrong, the User
  merges two People (choosing the name kept) or splits handles out to a Person of their own, and can
  rename anyone (their name wins over every Source's). Each change has Undo in its toast, through the
  People log. A Person's page (#122) opens it at them (`requestReveal(PEOPLE_SETTINGS, personId)`)
  to merge or split.
*/

/** The reveal channel (frame/reveal.ts) that opens Settings → People at a Person. */
export const PEOPLE_SETTINGS = 'settings-people';

/** More than this many matches, and the rest wait behind the search. */
const SHOWN = 100;

const pad = (n: number) => String(n).padStart(2, '0');
const metaClass = 'font-mono text-label leading-none font-medium uppercase tracking-label text-muted';

/** Makes a change to People and says so in a toast with Undo, which reverses it from the People log. */
async function changeWithUndo(change: PeopleApi['change'], action: PeopleAction, said: string) {
  let done: PeopleChange;
  try {
    done = await change(action);
  } catch (reason) {
    toast(errorText(reason));
    return null;
  }
  toast(said, {
    action: {
      label: 'Undo',
      onClick: () =>
        change({ type: 'undo', changeId: done.id }).catch((reason: unknown) => toast(errorText(reason))),
    },
  });
  return done;
}

export function PeopleSettings({ no }: { no: string }) {
  const { people, change, loaded } = usePeople();
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const searchId = useId();

  useReveal(PEOPLE_SETTINGS, (personId) => {
    setQuery('');
    setFocused(personId);
  });
  useEffect(() => {
    if (!focused) return;
    const frame = requestAnimationFrame(() =>
      list.current
        ?.querySelector(`[data-person-id="${CSS.escape(focused)}"]`)
        ?.scrollIntoView({ block: 'center' }),
    );
    return () => cancelAnimationFrame(frame);
  }, [focused]);

  const matching = useMemo(() => people.filter((person) => personMatches(person, query)), [people, query]);
  // Only People still there stay chosen (a merge or sync may have folded one away).
  const live = chosen.filter((id) => people.some((person) => person.id === id));
  const toggle = (id: string) =>
    setChosen((now) => (now.includes(id) ? now.filter((each) => each !== id) : [...now, id].slice(-2)));
  const pair =
    live.length === 2 ? live.map((id) => people.find((person) => person.id === id) as Person) : null;

  return (
    <SettingsGroup no={no} title="People" note={`${pad(people.length)} People`} data-testid="people-settings">
      <p className="m-0 border-b border-line2 py-3 pr-6 pl-13 text-note leading-[19px] text-muted">
        Everyone in your Sources, matched by email address: a Linear user, a GitHub login and an address that
        share one are one Person, shown by name everywhere. Merge two that are the same person, or split off a
        handle that isn’t theirs. Matching never undoes what you merge or split.
      </p>
      <div className="flex items-center gap-3 border-b border-line2 py-2.5 pr-6 pl-13">
        <label htmlFor={searchId} className="sr-only">
          Search People
        </label>
        <Input
          id={searchId}
          type="search"
          value={query}
          placeholder="Search by name, address or login…"
          className="max-w-[360px]"
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className={metaClass}>{query ? `${pad(matching.length)} match` : 'Choose two to merge'}</span>
      </div>
      {pair && (
        <MergeBar
          pair={pair as [Person, Person]}
          onDone={() => setChosen([])}
          onMerge={(action, said) => changeWithUndo(change, action, said)}
        />
      )}
      {loaded && !people.length ? (
        <p className="hatch m-0 border-b border-line2 py-3 pr-5 pl-13 text-heading text-faint">
          No one yet. People arrive with your Sources’ Items.
        </p>
      ) : (
        <ul ref={list} aria-label="People" className="m-0 list-none p-0">
          {matching.slice(0, SHOWN).map((person) => (
            <PersonRow
              key={person.id}
              person={person}
              chosen={live.includes(person.id)}
              focused={focused === person.id}
              onChoose={() => toggle(person.id)}
              change={(action, said) => changeWithUndo(change, action, said)}
            />
          ))}
        </ul>
      )}
      {matching.length > SHOWN && (
        <p className={cn(metaClass, 'm-0 border-b border-line2 py-2.5 pr-6 pl-13')}>
          {matching.length - SHOWN} more · search to find them
        </p>
      )}
    </SettingsGroup>
  );
}

type Change = (action: PeopleAction, said: string) => Promise<PeopleChange | null>;

/** Two People chosen: which name to keep, and Merge. The Person whose name is kept is the one kept. */
function MergeBar({
  pair,
  onMerge,
  onDone,
}: {
  pair: [Person, Person];
  onMerge: Change;
  onDone: () => void;
}) {
  const [keep, setKeep] = useState(pair[0].id);
  const kept = pair.find((person) => person.id === keep) ?? pair[0];
  const other = pair.find((person) => person.id !== kept.id) as Person;
  const name = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and form semantics
    <div
      role="group"
      aria-label="Merge People"
      className="flex flex-wrap items-center gap-3 border-b border-line bg-raise py-2.5 pr-6 pl-13"
    >
      <span className="text-note font-semibold text-ink">Merge into one Person, named</span>
      {pair.map((person) => (
        <label key={person.id} className="flex items-center gap-1.5 text-note text-text">
          <input type="radio" name={name} checked={keep === person.id} onChange={() => setKeep(person.id)} />
          {person.name}
        </label>
      ))}
      <Button
        size="sm"
        variant="primary"
        onClick={async () => {
          const done = await onMerge(
            { type: 'merge', personId: other.id, into: kept.id, name: kept.name },
            `Merged ${other.name} into ${kept.name}`,
          );
          if (done) onDone();
        }}
      >
        Merge
      </Button>
      <Button size="sm" variant="ghost" onClick={onDone}>
        Cancel
      </Button>
    </div>
  );
}

function PersonRow({
  person,
  chosen,
  focused,
  onChoose,
  change,
}: {
  person: Person;
  chosen: boolean;
  focused: boolean;
  onChoose: () => void;
  change: Change;
}) {
  const [mode, setMode] = useState<'show' | 'rename' | 'split'>('show');
  const [splitting, setSplitting] = useState<string[]>([]);
  const [name, setName] = useState(person.name);
  const nameId = useId();

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    const next = name.trim();
    if (!next || next === person.name) return setMode('show');
    if (
      await change({ type: 'rename', personId: person.id, name: next }, `Renamed ${person.name} to ${next}`)
    )
      setMode('show');
  };

  return (
    <li
      data-testid="person-row"
      data-person-id={person.id}
      aria-label={person.name}
      aria-current={focused || undefined}
      className={cn(
        'relative grid grid-cols-[22px_minmax(0,220px)_minmax(0,1fr)_auto] items-start gap-4 border-b border-line2 py-2 pr-6 pl-13',
        focused && 'bg-signal-focus shadow-[inset_3px_0_0_var(--signal)]',
        chosen && 'bg-raise',
      )}
    >
      <input
        type="checkbox"
        aria-label={`Choose ${person.name}`}
        checked={chosen}
        onChange={onChoose}
        className="mt-1"
      />
      <div className="min-w-0">
        {mode === 'rename' ? (
          <form onSubmit={rename} className="flex flex-col gap-1.5">
            <label htmlFor={nameId} className="sr-only">
              Name for {person.name}
            </label>
            <Input
              id={nameId}
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === 'Escape' && setMode('show')}
            />
            <span className="flex gap-1">
              <Button size="sm" type="submit" variant="primary">
                Save
              </Button>
              {person.userName !== null && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    const done = await change(
                      { type: 'rename', personId: person.id, name: null },
                      `${person.name} goes by the Sources’ name again`,
                    );
                    if (done) setMode('show');
                  }}
                >
                  Use the Sources’ name
                </Button>
              )}
            </span>
          </form>
        ) : (
          <div className="flex items-baseline gap-2">
            <span className="truncate text-row leading-[22px] font-semibold text-ink">{person.name}</span>
            {person.isUser && <span className={metaClass}>You</span>}
            {person.userName !== null && <span className={metaClass}>Your name</span>}
          </div>
        )}
      </div>
      <ul aria-label={`${person.name}’s handles`} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {person.handles.map((handle) => {
          const label = handleLabel(handle);
          return (
            <li
              key={handle.handle}
              className="inline-flex h-6 items-center gap-1.5 border border-line bg-sheet px-2 text-note"
              title={handle.handle}
            >
              {mode === 'split' && (
                <input
                  type="checkbox"
                  aria-label={label}
                  checked={splitting.includes(handle.handle)}
                  onChange={() =>
                    setSplitting((now) =>
                      now.includes(handle.handle)
                        ? now.filter((each) => each !== handle.handle)
                        : [...now, handle.handle],
                    )
                  }
                />
              )}
              {handle.source !== 'email' && (
                <span className="font-mono text-label uppercase tracking-label text-muted">
                  {handleSourceName(handle.source)}
                </span>
              )}
              <span className="text-text">{label}</span>
            </li>
          );
        })}
      </ul>
      <span className="flex items-center gap-1">
        {mode === 'split' ? (
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={!splitting.length || splitting.length >= person.handles.length}
              onClick={async () => {
                const done = await change(
                  { type: 'split', personId: person.id, handles: splitting },
                  `Split ${splitting.length === 1 ? 'a handle' : `${splitting.length} handles`} from ${person.name}`,
                );
                if (done) {
                  setSplitting([]);
                  setMode('show');
                }
              }}
            >
              Split off
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('show')}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Rename ${person.name}`}
              onClick={() => {
                setName(person.name);
                setMode('rename');
              }}
            >
              Rename
            </Button>
            {person.handles.length > 1 && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Split ${person.name}`}
                onClick={() => setMode('split')}
              >
                Split
              </Button>
            )}
          </>
        )}
      </span>
    </li>
  );
}
