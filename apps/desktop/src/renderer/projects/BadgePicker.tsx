import type { ActivityEntry, FiledBy, Item, Project } from '@commander/domain';
import { Badge, cn, Kbd, toast, usePortalContainer } from '@commander/ui';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useProjects } from './context';

/** What the picker files: an Item, by its id, title and current filing. */
export type PickerTarget = Pick<Item, 'id' | 'title' | 'filing'>;

const HOW: Record<FiledBy, string> = {
  user: 'Filed by you',
  rule: 'Filed by a Rule',
  ares: 'Filed by Ares',
  inherited: 'Follows its source',
};

type Choice = { project: Project | null; label: string };

/** The choices that match what was typed: Projects by code or name, and Unfiled. */
export function matchChoices(projects: readonly Project[], query: string): Choice[] {
  const q = query.trim().toLowerCase();
  const all: Choice[] = [
    ...projects.map((project) => ({ project, label: project.name })),
    { project: null, label: 'Unfiled' },
  ];
  if (!q) return all;
  const starts = (text: string) => text.toLowerCase().startsWith(q);
  const contains = (text: string) => text.toLowerCase().includes(q);
  // A code typed exactly comes first, then names that start with it, then anything containing it.
  const rank = ({ project, label }: Choice) => {
    if (project && project.code.toLowerCase() === q) return 0;
    if (starts(label) || (project && starts(project.code))) return 1;
    if (contains(label)) return 2;
    return 3;
  };
  return all
    .map((choice, index) => ({ choice, index, rank: rank(choice) }))
    .filter(({ rank }) => rank < 3)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ choice }) => choice);
}

/**
 * The Badge picker (`b`, or a click on a Badge): files the target into a Project, or unfiles it.
 * Type to narrow by code or name, `↑`/`↓` to move, `Enter` or the number key to choose, `Esc` to
 * close. It opens beside `anchor` (the target's Badge), like the prototype's picker.
 */
export function BadgePicker({
  target,
  anchor,
  onPick,
  onClose,
}: {
  target: PickerTarget;
  anchor: HTMLElement | null;
  onPick: (projectId: string | null) => void;
  onClose: () => void;
}) {
  const { projects } = useProjects();
  const portal = usePortalContainer() ?? document.body;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const choices = useMemo(() => matchChoices(projects, query), [projects, query]);
  const current = target.filing?.projectId ?? null;
  const highlighted = Math.min(active, Math.max(0, choices.length - 1));

  // Beside the anchor, kept on screen: below it, or above when there is no room below.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    const rect = anchor?.getBoundingClientRect() ?? {
      left: window.innerWidth / 2 - 148,
      top: 120,
      bottom: 120,
    };
    const { offsetWidth: w, offsetHeight: h } = el;
    const left = Math.min(window.innerWidth - w - 12, Math.max(12, rect.left - 6));
    let top = rect.bottom + 6;
    if (top + h > window.innerHeight - 12) top = Math.max(12, rect.top - h - 6);
    setPlace({ left, top });
  }, [anchor]);

  // A click anywhere else closes it.
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onPointer, true);
    return () => document.removeEventListener('pointerdown', onPointer, true);
  }, [onClose]);

  const choose = (choice: Choice | undefined) => {
    if (!choice) return;
    onPick(choice.project?.id ?? null);
  };

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label="Badge picker"
      data-testid="badge-picker"
      className="fixed z-45 w-[296px] border border-ink bg-sheet text-text"
      style={place ?? { left: -9999, top: 0 }}
    >
      <div className="flex h-7 items-center justify-between gap-2.5 bg-ink px-2.5 font-mono text-label leading-none font-semibold uppercase tracking-label whitespace-nowrap text-sheet">
        <span>Project</span>
        <span className="min-w-0 truncate font-medium opacity-70">{target.title}</span>
      </div>
      <input
        // biome-ignore lint/a11y/noAutofocus: the picker opens to be typed into
        autoFocus
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="badge-picker-choices"
        aria-label="Filter Projects by code or name"
        aria-activedescendant={choices.length ? `badge-picker-choice-${highlighted}` : undefined}
        placeholder="Type a code or name…"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          const number = /^[1-9]$/.test(event.key) ? Number(event.key) : 0;
          if (event.key === 'Escape') onClose();
          else if (event.key === 'Enter') choose(choices[highlighted]);
          else if (event.key === 'ArrowDown') setActive((highlighted + 1) % Math.max(1, choices.length));
          else if (event.key === 'ArrowUp')
            setActive((highlighted - 1 + choices.length) % Math.max(1, choices.length));
          else if (number) choose(choices[number - 1]);
          else return;
          event.preventDefault();
          event.stopPropagation();
        }}
        className="h-[34px] w-full border-0 border-b border-line bg-transparent px-2.5 font-sans text-note text-ink caret-signal outline-none placeholder:text-faint"
      />
      <div id="badge-picker-choices" role="listbox" aria-label="Projects">
        {choices.map((choice, index) => {
          const isCurrent = (choice.project?.id ?? null) === current;
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard chooses through the combobox above
            <div
              key={choice.project?.id ?? 'unfiled'}
              id={`badge-picker-choice-${index}`}
              role="option"
              aria-selected={index === highlighted}
              tabIndex={-1}
              onPointerEnter={() => setActive(index)}
              onClick={() => choose(choice)}
              className={cn(
                'grid h-[34px] w-full cursor-pointer grid-cols-[30px_minmax(0,1fr)_auto_auto] items-center gap-2 border-b border-line2 px-2.5 text-left',
                index === highlighted && 'bg-raise',
                isCurrent && 'shadow-[inset_3px_0_0_var(--ink)]',
              )}
            >
              {choice.project ? (
                <Badge
                  code={choice.project.code}
                  accent={choice.project.accent}
                  project={choice.project.name}
                />
              ) : (
                <Badge kind="unfiled" />
              )}
              <span className="truncate font-sans text-heading leading-none font-semibold text-ink">
                {choice.label}
              </span>
              <span className="font-mono text-tiny leading-none font-medium uppercase tracking-caps text-muted">
                {isCurrent ? 'Current' : ''}
              </span>
              {index < 9 ? <Kbd className="h-[17px] min-w-[17px] text-label">{index + 1}</Kbd> : <span />}
            </div>
          );
        })}
        {!choices.length && (
          <p className="m-0 border-b border-line2 px-2.5 py-2.5 text-note text-faint">
            No Project matches “{query.trim()}”.
          </p>
        )}
      </div>
      <div className="px-2.5 pt-[9px] pb-2.5 font-mono text-label leading-[1.55] font-medium uppercase tracking-tag text-muted">
        <b className="font-semibold text-ink">{target.filing ? HOW[target.filing.filedBy] : 'Unfiled'}</b>
        {' · '}
        <Kbd className="h-4 min-w-4 text-tiny">↵</Kbd> files ·{' '}
        <Kbd className="h-4 min-w-4 text-tiny">Esc</Kbd> closes
      </div>
    </div>,
    portal,
  );
}

/**
 * The Badge picker as a Section uses it: `open(item)` shows the picker beside the Item's Badge (the
 * element marked `data-item-id` holding a Badge), and choosing files the Item by the User. The change
 * goes through `apply`, so the Section reloads and can undo it; `undo` backs the toast's Undo.
 */
export function useBadgePicker(
  apply: (change: () => Promise<ActivityEntry>) => Promise<ActivityEntry | null>,
  undo: (entryId: number) => void,
): { open(item: PickerTarget, anchor?: HTMLElement | null): void; picker: ReactNode } {
  const { file, projectOf } = useProjects();
  const [target, setTarget] = useState<{ item: PickerTarget; anchor: HTMLElement | null } | null>(null);

  const open = useCallback((item: PickerTarget, anchor?: HTMLElement | null) => {
    const badge = document.querySelector<HTMLElement>(
      `[data-item-id="${CSS.escape(item.id)}"] [data-slot="badge"]`,
    );
    setTarget({ item, anchor: anchor ?? badge });
  }, []);
  const close = useCallback(() => setTarget(null), []);

  const pick = async (item: PickerTarget, projectId: string | null) => {
    setTarget(null);
    if ((item.filing?.projectId ?? null) === projectId && item.filing?.filedBy === 'user') return;
    if (!item.filing && !projectId) return;
    const entry = await apply(() => file(item.id, projectId));
    if (!entry) return;
    const project = projectOf(projectId ? { projectId, filedBy: 'user' } : null);
    toast(project ? `Filed under ${project.code}: ${item.title}` : `Unfiled: ${item.title}`, {
      action: { label: 'Undo', onClick: () => undo(entry.id) },
    });
  };

  const picker = target && (
    <BadgePicker
      target={target.item}
      anchor={target.anchor}
      onClose={close}
      onPick={(projectId) => pick(target.item, projectId)}
    />
  );
  return { open, picker };
}

type OpenPicker = (item: PickerTarget, anchor?: HTMLElement | null) => void;

const PickBadgeContext = createContext<OpenPicker | null>(null);

/** Lets the Badges inside open the Section's Badge picker (`useBadgePicker().open`) when clicked. */
export const PickBadgeProvider = PickBadgeContext.Provider;

/** The Section's Badge picker opener, or null where Badges can't be clicked to re-file. */
export function usePickBadge(): OpenPicker | null {
  return useContext(PickBadgeContext);
}
