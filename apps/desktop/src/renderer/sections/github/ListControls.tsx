import { cn, Led, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@commander/ui';
import type { FilterKey, FilterOption, FilterOptions, WorkFilters, WorkView } from './work';

const pad = (n: number) => String(n).padStart(2, '0');

const VIEWS: { view: WorkView; label: string }[] = [
  { view: 'mine', label: 'Your work' },
  { view: 'pulls', label: 'Pull requests' },
  { view: 'issues', label: 'Issues' },
];

/**
 * The view switch under the Project filter, after the prototype's Bucket tabs (.bkts) as the Linear
 * Section draws them: Your work, Pull requests and Issues with their open counts, and the thin sync status line
 * on the right.
 */
export function ViewSwitch({
  view,
  counts,
  onView,
  status,
}: {
  view: WorkView;
  counts: Record<WorkView, number>;
  onView: (view: WorkView) => void;
  status: { text: string; problem: boolean; syncing: boolean };
}) {
  return (
    <div className="flex h-14 flex-none items-stretch border-b border-line">
      <div
        role="tablist"
        aria-label="Which work"
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
        data-testid="github-sync-status"
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
  { key: 'org', label: 'Org' },
  { key: 'repo', label: 'Repo' },
  { key: 'author', label: 'Author' },
  { key: 'state', label: 'State' },
  { key: 'label', label: 'Label' },
];

const ANY = '__any';

/**
 * The GitHub filters (org, repo, author, state, label), each a pop-up of its choices with counts.
 * They narrow the list together with the Project filter above.
 */
export function WorkFilterBar({
  filters,
  options,
  onFilter,
  onClear,
}: {
  filters: WorkFilters;
  options: FilterOptions;
  onFilter: (key: FilterKey, value: string | null) => void;
  onClear: () => void;
}) {
  const active = Object.values(filters).some((value) => value !== null);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and form semantics
    <div
      role="group"
      aria-label="GitHub filters"
      className="flex h-9 flex-none items-stretch border-b border-line bg-sheet"
    >
      <span
        title="GitHub"
        className="grid w-[41px] flex-none place-items-center border-r border-line2 font-mono text-micro leading-none font-semibold tracking-label text-faint"
      >
        GH
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
