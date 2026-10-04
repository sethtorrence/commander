import type { Project, SearchQuery, SearchResult } from '@commander/domain';
import { cn, Dialog, DialogContent, DialogDescription, DialogTitle, Kbd } from '@commander/ui';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ItemBadge } from '../projects/badges';
import type { Command } from './commands';
import { readQuery, SECTION_KINDS, toggleChip } from './query';
import { type PaletteAction, type PaletteContext, type PaletteRow, paletteGroups } from './rows';

/*
  The Ctrl+K palette, after the prototype's jump palette (dashboard-layout/variants/hub.html): one
  input on a sheet laid over the drawing, the rows grouped under sticky headings, the keys along the
  foot. It finds as the User types (the Core's search, local and instant), jumps to Sections,
  Projects and today's Daily Note, and runs commands. A filter row under the input picks chips.
  `↑`/`↓` move, `Enter` acts, `Esc` closes.
*/

export interface PaletteProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The input it opens with: empty for Ctrl+K, the Section's chips for `/`. */
  initial: string;
  /** Jump (Ctrl+K) or Find (`/`, a Section search): the label beside the input. */
  mode: 'jump' | 'find';
  search(query: SearchQuery): Promise<SearchResult>;
  sections: PaletteContext['sections'];
  current: string;
  projects: readonly Project[];
  /** The commands to offer, read when it opens. */
  commands: () => readonly Command[];
  /** Every Account, for `@` chips; the Linear ones with their URL key, for Search in Linear. */
  accounts: readonly { id: string; name: string; source: string; urlKey?: string }[];
  now: Date;
  today: string;
  onAction(action: PaletteAction): void;
}

const keyOf = (query: SearchQuery | null) => (query ? JSON.stringify(query) : '');

export function Palette(props: PaletteProps) {
  const { open, onOpenChange, initial, mode, search, onAction } = props;
  const [input, setInput] = useState(initial);
  const [selected, setSelected] = useState(0);
  const [answer, setAnswer] = useState<{ key: string; result: SearchResult } | null>(null);
  const [commands, setCommands] = useState<readonly Command[]>([]);
  const [enterWaiting, setEnterWaiting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const acted = useRef(false);
  const listId = useId();

  // Each time it opens: the starting input, and the commands available now.
  const commandsNow = useRef(props.commands);
  commandsNow.current = props.commands;
  useEffect(() => {
    if (!open) return;
    setInput(initial);
    setSelected(0);
    setAnswer(null);
    setEnterWaiting(false);
    setCommands(commandsNow.current());
    acted.current = false;
  }, [open, initial]);

  const query = useMemo(
    () => readQuery(input, { projects: props.projects, accounts: props.accounts, now: props.now }),
    [input, props.projects, props.accounts, props.now],
  );
  const searchKey = keyOf(query.search);

  // Results as the User types; an answer to an older input never replaces a newer one.
  useEffect(() => {
    if (!open || !query.search) return;
    let current = true;
    const key = keyOf(query.search);
    search(query.search).then(
      (result) => current && setAnswer({ key, result }),
      () => current && setAnswer({ key, result: { hits: [], projects: [] } }),
    );
    return () => {
      current = false;
    };
  }, [open, query.search, search]);

  const linearAccounts = useMemo(
    () =>
      props.accounts.flatMap((account) =>
        account.source === 'linear' && account.urlKey ? [{ name: account.name, urlKey: account.urlKey }] : [],
      ),
    [props.accounts],
  );
  const fresh = !query.search || answer?.key === searchKey;
  const groups = useMemo(
    () =>
      paletteGroups({
        query,
        result: query.search ? (answer?.result ?? null) : null,
        sections: props.sections,
        current: props.current,
        projects: props.projects,
        commands,
        linearAccounts,
        today: props.today,
      }),
    [query, answer, props.sections, props.current, props.projects, commands, linearAccounts, props.today],
  );
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const at = Math.min(selected, Math.max(0, rows.length - 1));

  const act = (row: PaletteRow | undefined) => {
    if (!row) return;
    acted.current = true;
    onOpenChange(false);
    onAction(row.action);
  };

  // Enter pressed before the results for the latest input arrived acts once they have.
  useEffect(() => {
    if (enterWaiting && fresh) {
      setEnterWaiting(false);
      act(rows[at]);
    }
  });

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  });

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!rows.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setSelected((at + step + rows.length) % rows.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (fresh) act(rows[at]);
      else setEnterWaiting(true);
    }
  };

  const filterChips = [
    ...props.sections
      .filter((section) => SECTION_KINDS[section.id])
      .map((section) => ({ token: `in:${section.id}`, label: section.label })),
    ...props.projects.map((project) => ({ token: `#${project.code}`, label: project.code })),
  ];
  const typedChips = new Set(query.chips.map((chip) => chip.token.toLowerCase()));
  let index = 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="palette"
        overlayClassName="z-60 bg-[rgba(10,10,10,.42)]"
        className={cn(
          'top-24 left-[calc(var(--rul)+(100%-var(--rul))/2)] z-61 w-[min(680px,calc(100vw-200px))] translate-y-0',
          'flex max-h-[calc(100vh-200px)] flex-col bg-sheet',
          "before:absolute before:-top-px before:-right-px before:-left-px before:h-[3px] before:bg-ink before:content-['']",
        )}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
        // After opening something, focus stays where that put it rather than going back.
        onCloseAutoFocus={(event) => {
          if (acted.current) event.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">
          {mode === 'find' ? 'Search' : 'Jump, search and commands'}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Type to find Todos, notes, Linear issues, Projects, Sections and commands.
        </DialogDescription>
        <div className="flex h-14 flex-none items-center gap-3 border-b border-line pr-3.5">
          <span className="grid self-stretch place-items-center border-r border-line px-3.5 font-mono text-label leading-none font-semibold uppercase tracking-wide text-muted">
            {mode === 'find' ? 'Find' : 'Jump'}
          </span>
          <input
            ref={inputRef}
            role="combobox"
            aria-label="Search Commander"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={rows[at] ? `${listId}-${at}` : undefined}
            aria-autocomplete="list"
            className="min-w-0 flex-1 border-0 bg-transparent font-sans text-lead leading-none font-medium text-ink caret-signal outline-none placeholder:text-faint"
            placeholder="Section, Todo, note, issue, command…"
            autoComplete="off"
            spellCheck={false}
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div
          className="flex flex-none flex-wrap items-center gap-1.5 border-b border-line2 px-3.5 py-1.5 font-mono text-label leading-none font-medium uppercase tracking-label text-muted"
          data-testid="palette-filters"
        >
          <span className="mr-1">Filter</span>
          {filterChips.map((chip) => {
            const on = typedChips.has(chip.token.toLowerCase());
            return (
              <button
                key={chip.token}
                type="button"
                aria-pressed={on}
                title={chip.token}
                className={cn(
                  'h-[18px] cursor-pointer border border-line px-1.5 font-mono text-label uppercase tracking-label',
                  on ? 'border-ink bg-ink text-sheet' : 'text-muted hover:bg-raise hover:text-ink',
                )}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setInput((now) => toggleChip(now, chip.token));
                  setSelected(0);
                }}
              >
                {chip.label}
              </button>
            );
          })}
          {query.chips
            .filter((chip) => chip.type === 'account' || chip.type === 'after' || chip.type === 'before')
            .map((chip) => (
              <span
                key={chip.token}
                className="h-[18px] border border-ink bg-ink px-1.5 leading-[16px] text-sheet"
              >
                {chip.label}
              </span>
            ))}
        </div>
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Results"
          className="min-h-[102px] flex-1 overflow-auto [scrollbar-width:thin]"
        >
          {groups.map((group) => (
            // biome-ignore lint/a11y/useSemanticElements: an ARIA group inside a listbox, not a form fieldset
            <div key={group.title} role="group" aria-label={group.title}>
              <div
                role="presentation"
                className="sticky top-0 z-1 flex h-6 items-center justify-between border-b border-line2 bg-bg px-3.5 font-mono text-tiny leading-none font-semibold uppercase tracking-wide text-muted"
              >
                <span>{group.title}</span>
                <span>{String(group.rows.length).padStart(2, '0')}</span>
              </div>
              {group.rows.map((row) => {
                const n = index++;
                const isSelected = n === at;
                return (
                  // biome-ignore lint/a11y/useFocusableInteractive lint/a11y/useKeyWithClickEvents: keys stay in the input, which points at the selected option (aria-activedescendant)
                  <div
                    key={row.key}
                    id={`${listId}-${n}`}
                    role="option"
                    aria-selected={isSelected}
                    data-testid="palette-row"
                    className={cn(
                      'grid h-[34px] cursor-pointer grid-cols-[96px_minmax(0,1fr)_auto] items-center gap-3 border-b border-line2 px-3.5',
                      isSelected && 'bg-ink',
                    )}
                    onMouseMove={() => n !== at && setSelected(n)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => act(row)}
                  >
                    <span
                      className={cn(
                        'truncate font-mono text-kbd leading-none font-medium text-muted',
                        isSelected && 'text-sheet',
                      )}
                    >
                      {row.tag}
                    </span>
                    <span className={cn('truncate text-[14.5px] text-ink', isSelected && 'text-sheet')}>
                      {row.label}
                    </span>
                    <span
                      className={cn(
                        'flex items-center gap-2 font-mono text-label leading-none font-medium uppercase tracking-label whitespace-nowrap text-muted',
                        isSelected && 'text-sheet',
                      )}
                    >
                      {row.filing !== undefined && <ItemBadge filing={row.filing} size="sm" />}
                      {row.hint}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
          {!groups.length && (
            <div className="px-3.5 py-4.5 text-ui text-muted">
              {query.search || !query.chips.length
                ? 'Nothing matches. Try other words, a Section or a Project.'
                : 'Type to search.'}
            </div>
          )}
        </div>
        <div className="flex flex-none flex-wrap gap-4 border-t border-line px-3.5 py-[9px] font-mono text-label leading-none font-medium uppercase tracking-label text-muted [&_kbd]:h-[17px] [&_kbd]:min-w-[17px] [&_kbd]:text-label">
          <span className="flex items-center gap-[5px]">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> Move
          </span>
          <span className="flex items-center gap-[5px]">
            <Kbd>↵</Kbd> Open in its Section
          </span>
          <span className="flex items-center gap-[5px]">
            <Kbd>#</Kbd>
            <Kbd>in:</Kbd>
            <Kbd>@</Kbd> Filter
          </span>
          <span className="flex items-center gap-[5px]">
            <Kbd>/</Kbd> This Section, when not typing
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
