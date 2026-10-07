import {
  ACTION_KIND_NAMES,
  type ActionKind,
  type AresActivity,
  AUTONOMY_SECTION_NAMES,
  type AutonomySection,
  actionKinds,
  autonomySections,
} from '@commander/domain';
import {
  AresText,
  Button,
  ButtonGroup,
  cn,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@commander/ui';
import { useState } from 'react';
import { useProjectsIfAny } from '../../projects/context';
import { SettingsGroup } from '../../settings/parts';
import {
  type AresActivityFilters,
  type AutonomyClient,
  bulkAcceptable,
  describeActivity,
  describeItemActions,
} from './activity';
import { openConversation } from './conversations';
import { useAresActivity } from './use-ares-activity';

const pad = (n: number) => String(n).padStart(2, '0');
const when = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const ALL = 'all';

/**
 * Ares's activity page: everything Ares did or suggested, newest first, with his reason and what
 * caused it, filterable by Action kind and Section. Suggestions are accepted or dismissed here
 * (Organise and Tidy your Sources all at once, too), and what he did can be undone.
 */
export function ActivityPage({
  client,
  shown,
  onAresActivity,
}: {
  client: AutonomyClient;
  shown: boolean;
  onAresActivity?: (listener: () => void) => () => void;
}) {
  const [filters, setFilters] = useState<AresActivityFilters>({});
  const state = useAresActivity(client, filters, shown, onAresActivity);
  const rows = state.rows ?? [];
  const waiting = (kind: ActionKind) =>
    rows.filter((row) => row.status === 'pending' && row.actionKind === kind);

  return (
    <SettingsGroup no="A1" title="Activity" note={`${pad(rows.length)} lines`}>
      <div className="flex flex-wrap items-center gap-3 border-b border-line2 py-2.5 pr-5 pl-13">
        <Filter
          label="Action kind"
          all="Every Action kind"
          value={filters.actionKind}
          options={actionKinds.map((kind) => [kind, ACTION_KIND_NAMES[kind]])}
          onChange={(actionKind) =>
            setFilters((current) => ({ ...current, actionKind: actionKind as ActionKind }))
          }
        />
        <Filter
          label="Section"
          all="Every Section"
          value={filters.section}
          options={autonomySections.map((section) => [section, AUTONOMY_SECTION_NAMES[section]])}
          onChange={(section) =>
            setFilters((current) => ({ ...current, section: section as AutonomySection }))
          }
        />
        <span className="ml-auto flex gap-2">
          {actionKinds.filter(bulkAcceptable).map((kind) => {
            const count = waiting(kind).length;
            return count > 1 ? (
              <Button key={kind} variant="signal" onClick={() => state.acceptAll(kind)}>
                Accept all {ACTION_KIND_NAMES[kind]} ({count})
              </Button>
            ) : null;
          })}
        </span>
      </div>
      {rows.length ? (
        <ol aria-label="Ares’s activity" className="m-0 list-none p-0">
          {rows.map((row) => (
            <ActivityRow key={row.id} row={row} state={state} />
          ))}
        </ol>
      ) : (
        <p className="hatch m-0 border-b border-line2 py-3 pr-5 pl-13 text-heading text-faint">
          {state.rows ? 'Nothing from Ares here yet.' : 'Loading…'}
        </p>
      )}
    </SettingsGroup>
  );
}

function Filter({
  label,
  all,
  value,
  options,
  onChange,
}: {
  label: string;
  all: string;
  value: string | undefined;
  options: [string, string][];
  onChange: (value: string | undefined) => void;
}) {
  return (
    <Select value={value ?? ALL} onValueChange={(next) => onChange(next === ALL ? undefined : next)}>
      <SelectTrigger aria-label={label} className="w-52">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{all}</SelectItem>
        {options.map(([option, name]) => (
          <SelectItem key={option} value={option}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ActivityRow({ row, state }: { row: AresActivity; state: ReturnType<typeof useAresActivity> }) {
  const projects = useProjectsIfAny();
  const projectName = (projectId: string) => {
    const project = projects?.projectById(projectId);
    return project && `${project.code} · ${project.name}`;
  };
  const pending = row.status === 'pending';
  const where = row.section ? AUTONOMY_SECTION_NAMES[row.section] : 'Everywhere';
  // Act for you and Delete are accepted one at a time, with everything they'll do in view.
  const oneAtATime = !bulkAcceptable(row.actionKind);
  // What Ares wrote may link only to what the Items it was about say (AresText).
  const sources = [row.item?.title ?? '', row.cause?.item?.title ?? ''];
  return (
    <li
      aria-label={`${row.name}: ${row.item?.title ?? 'an Item'}`}
      className={cn(
        'relative grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1 border-b border-line2 py-2.5 pr-5 pl-13',
        pending && 'shadow-[inset_3px_0_0_var(--signal)]',
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2.5 font-mono text-label leading-5 font-semibold uppercase tracking-label text-muted">
        <time dateTime={new Date(row.at).toISOString()} className="tabular-nums">
          {when.format(row.at)}
        </time>
        <span className="text-ink">{row.name}</span>
        <span>
          {ACTION_KIND_NAMES[row.actionKind]} · {where}
        </span>
        <span
          data-testid="activity-status"
          className={cn('border px-[7px]', pending ? 'border-signal text-signal-ink' : 'border-line')}
        >
          {describeActivity(row)}
        </span>
      </div>
      <div className="row-span-3 flex items-start">
        {pending ? (
          <ButtonGroup>
            <Button variant="signal" onClick={() => state.accept(row.id)}>
              {oneAtATime ? 'Accept this one' : 'Accept'}
            </Button>
            <Button onClick={() => state.dismiss(row.id)}>Dismiss</Button>
          </ButtonGroup>
        ) : (
          row.undoable && <Button onClick={() => state.undo(row.id)}>Undo</Button>
        )}
      </div>
      <div className="min-w-0">
        {describeItemActions(row.itemActions, projectName).map((line) => (
          <p key={line} className="m-0 text-row leading-6 font-semibold text-ink">
            <AresText inline text={line} sources={sources} />
          </p>
        ))}
        <p className="m-0 text-note leading-5 text-muted">
          On <span className="text-text">{row.item?.title ?? 'an Item that has gone'}</span>
        </p>
      </div>
      <p className="m-0 min-w-0 text-note leading-5 text-text">
        <span className="text-muted">Why: </span>
        <AresText inline text={row.reason} sources={sources} />
        <Cause row={row} />
        <FromConversation row={row} />
      </p>
    </li>
  );
}

/** What caused it. A chained suggestion always says so: "Suggested because of Dana's email, 10:42". */
function Cause({ row }: { row: AresActivity }) {
  const cause = row.cause;
  if (!cause?.item || (!row.chained && cause.item.id === row.itemId)) return null;
  const at = cause.entry?.at;
  return (
    <span data-testid="activity-cause" className="block text-muted">
      {row.chained ? 'Suggested because of ' : 'Because of '}
      <cite className="font-semibold text-ink not-italic">{cause.item.title}</cite>
      {at !== undefined && `, ${when.format(at)}`}
    </span>
  );
}

/** The Conversation it was asked for in (#196), which opens there. */
function FromConversation({ row }: { row: AresActivity }) {
  const asked = row.conversation;
  if (!asked) return null;
  return (
    <span data-testid="activity-conversation" className="block text-muted">
      {asked.title === null ? (
        'Asked for in a Conversation since deleted'
      ) : (
        <>
          Asked for in your Conversation{' '}
          <button
            type="button"
            onClick={() => openConversation(asked.conversationId)}
            className="cursor-pointer border-0 bg-transparent p-0 font-semibold text-ink underline decoration-line underline-offset-2 hover:decoration-ink"
          >
            {asked.title}
          </button>
        </>
      )}
    </span>
  );
}
