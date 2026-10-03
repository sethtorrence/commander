import { cn, Led, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@commander/ui';
import type { FilterKey, FilterOption, FilterOptions, IssueFilters, IssueView } from './issues';

const pad = (n: number) => String(n).padStart(2, '0');

const VIEWS: { view: IssueView; label: string }[] = [
  { view: 'mine', label: 'Assigned to me' },
  { view: 'all', label: 'All tickets' },
];

/**
 * The view switch under the Project filter, after the prototype's Bucket tabs (.bkts): Assigned to
 * me and All tickets with their open counts, and the thin sync status line on the right.
 */
export function ViewSwitch({
  view,
  counts,
  onView,
  status,
}: {
  view: IssueView;
  counts: Record<IssueView, number>;
  onView: (view: IssueView) => void;
  status: { text: string; problem: boolean; syncing: boolean };
}) {
  return (
    <div className="flex h-14 flex-none items-stretch border-b border-line">
      <div
        role="tablist"
        aria-label="Which issues"
        className="ml-[41px] flex items-stretch border-l border-line2"
      >
        {VIEWS.map(({ view: each, label }) => {
          const on = each === view;
          return (
            <button
              key={each}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onView(each)}
              className={cn(
                'flex w-[168px] cursor-pointer flex-col items-start justify-center gap-1.5 border-0 border-r border-line2 bg-transparent px-3.5 text-left',
                on ? 'bg-sheet shadow-[inset_0_-3px_0_var(--ink)]' : 'hover:bg-raise',
              )}
            >
              <span
                className={cn(
                  'font-mono text-label leading-none uppercase tracking-caps whitespace-nowrap',
                  on ? 'font-semibold text-ink' : 'font-medium text-muted',
                )}
              >
                {label}
              </span>
              <span
                className={cn(
                  'font-sans text-[22px] leading-none tabular-nums font-stretch-(--stretch-wide)',
                  counts[each] ? 'font-bold text-ink' : 'font-normal text-faint',
                )}
              >
                {pad(counts[each])}
              </span>
            </button>
          );
        })}
      </div>
      <p
        data-testid="linear-sync-status"
        role="status"
        className={cn(
          'm-0 ml-auto flex min-w-0 items-center gap-2 self-center px-4 text-right font-mono text-label leading-tight uppercase tracking-label',
          status.problem ? 'font-semibold text-ink' : 'font-medium text-faint',
        )}
      >
        {status.syncing && <Led size="sm" />}
        <span className="truncate">{status.text}</span>
      </p>
    </div>
  );
}

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'team', label: 'Team' },
  { key: 'linearProject', label: 'Linear project' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'state', label: 'State' },
  { key: 'cycle', label: 'Cycle' },
];

const ANY = '__any';

/**
 * The Linear filters (team, Linear project, assignee, state, cycle), each a pop-up of its choices
 * with counts, plus the current cycle as a shortcut. They narrow the list together with the Project
 * filter above.
 */
export function IssueFilterBar({
  filters,
  options,
  onFilter,
  onClear,
}: {
  filters: IssueFilters;
  options: FilterOptions;
  onFilter: (key: FilterKey, value: string | null) => void;
  onClear: () => void;
}) {
  const active = Object.values(filters).some((value) => value !== null);
  const current = filters.cycle === 'current';
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and form semantics
    <div
      role="group"
      aria-label="Linear filters"
      className="flex h-9 flex-none items-stretch border-b border-line bg-sheet"
    >
      <span
        title="Linear"
        className="grid w-[41px] flex-none place-items-center border-r border-line2 font-mono text-micro leading-none font-semibold tracking-label text-faint"
      >
        LIN
      </span>
      {FILTERS.map(({ key, label }) => (
        <FilterSelect
          key={key}
          label={label}
          value={filters[key]}
          options={options[key]}
          onChange={(value) => onFilter(key, value)}
        />
      ))}
      <button
        type="button"
        aria-pressed={current}
        onClick={() => onFilter('cycle', current ? null : 'current')}
        className={cn(
          'flex cursor-pointer items-center border-0 border-r border-line2 px-3 font-mono text-label-lg leading-none font-semibold uppercase tracking-label whitespace-nowrap',
          current ? 'bg-ink text-sheet' : 'bg-transparent text-muted hover:bg-raise hover:text-ink',
        )}
      >
        Current cycle
      </button>
      <span className="flex-1" />
      {active && (
        <button
          type="button"
          onClick={onClear}
          className="cursor-pointer border-0 border-l border-line2 bg-transparent px-3.5 font-mono text-label leading-none font-medium uppercase tracking-label whitespace-nowrap text-muted hover:bg-raise hover:text-ink"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: FilterOption[];
  onChange: (value: string | null) => void;
}) {
  const chosen = options.find((option) => option.value === value);
  return (
    <Select value={value ?? ANY} onValueChange={(next) => onChange(next === ANY ? null : next)}>
      <SelectTrigger
        aria-label={label}
        className={cn(
          'h-full w-auto max-w-[220px] gap-2 border-0 border-r border-line2 px-3 hover:bg-raise data-[state=open]:bg-raise',
          value !== null && 'bg-raise',
        )}
      >
        <SelectValue>
          <span className="font-medium text-faint">{label}</span>{' '}
          <span className={value === null ? 'text-muted' : 'text-ink'}>
            {value === null ? 'Any' : (chosen?.label ?? 'None left')}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>Any {label.toLowerCase()}</SelectItem>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            className={option.count ? undefined : 'text-faint'}
          >
            {option.label}
            <span className="ml-3 font-mono text-label tabular-nums text-muted">{pad(option.count)}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
