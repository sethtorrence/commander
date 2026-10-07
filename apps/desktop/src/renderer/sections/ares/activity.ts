import {
  type ActionKind,
  type AresActivity,
  type AutonomySection,
  chatReply,
  type ItemKind,
  MESSAGE_FIELD,
  type ProposedItemAction,
} from '@commander/domain';

/*
  Ares's activity page's view of the gate: everything Ares did or suggested, reached only through
  the window's bridge (`window.commander.autonomy`), where accepting, dismissing and undoing are
  the User's.
*/

/** The window's autonomy channel (the preload bridge), or a stand-in for tests. */
export type AutonomyClient = Window['commander']['autonomy'];

export interface AresActivityFilters {
  actionKind?: ActionKind;
  section?: AutonomySection;
}

/** Whether a line is a change to Ares's own settings (#197): always asked, confirmed one at a time. */
export function isSettingChange(row: Pick<AresActivity, 'itemActions'>): boolean {
  return row.itemActions.some((action) => action.type === 'change-setting');
}

/** Organise and Tidy your Sources suggestions can be accepted all at once; the others one at a time. */
export function bulkAcceptable(kind: ActionKind): boolean {
  return kind === 'organise' || kind === 'tidy-sources';
}

const KIND_NAMES: Partial<Record<ItemKind, string>> = { todo: 'Todo', block: 'Block', event: 'event' };

const dueDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const snoozeTime = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** A due day (YYYY-MM-DD) as a line names it: "Fri 9 Oct". */
function dueWords(day: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return dueDay.format(new Date(year, month - 1, date));
}

// What a change to one of a Source Item's synced fields does, where it can be told in words (#196):
// a Linear issue's state and assignee, an email's Snooze.
function fieldLine(field: string, value: unknown): string | null {
  const named = value && typeof value === 'object' ? (value as { name?: unknown }).name : undefined;
  switch (field) {
    case 'state':
      return typeof named === 'string' ? `Move it to ${named} in Linear` : null;
    case 'assignee':
      if (value === null) return 'Unassign it in Linear';
      return typeof named === 'string' ? `Assign it to ${named} in Linear` : null;
    case 'snooze': {
      if (value === null) return 'Unsnooze it';
      const until = (value as { until?: unknown }).until;
      return typeof until === 'number' ? `Snooze the thread until ${snoozeTime.format(until)}` : null;
    }
    default:
      return null;
  }
}

// A reply to an invitation (#129), by the answer it gives: to that event, and to its whole series.
const REPLIES: Record<string, [string, string]> = {
  accepted: ['Accept the invitation', 'Accept every event in the series'],
  tentative: ['Answer Maybe to the invitation', 'Answer Maybe to every event in the series'],
  declined: ['Decline the invitation', 'Decline every event in the series'],
};

/**
 * What a proposal does (or would do), one plain line per change, so it can be judged before
 * accepting. `projectName` names a Project by its id ("TL · Titanlink"), where the Projects are known.
 */
export function describeItemActions(
  actions: ProposedItemAction[],
  projectName: (projectId: string) => string | undefined = () => undefined,
): string[] {
  const lines = actions.flatMap((action): string[] => {
    switch (action.type) {
      case 'create': {
        const detail = action.item.detail;
        const due = detail?.kind === 'todo' && detail.dueOn ? `, due ${dueWords(detail.dueOn)}` : '';
        const filed = action.item.filing
          ? `, filed under ${projectName(action.item.filing.projectId) ?? action.item.filing.projectId}`
          : '';
        return [
          `Add the ${KIND_NAMES[action.item.kind] ?? action.item.kind} “${action.item.title}”${due}${filed}`,
        ];
      }
      case 'send-to-linear': {
        // Send to Linear (#196): the new issue as Linear will have it.
        const { team, title, assignee, state } = action.draft;
        return [
          `Send it to Linear as a new ${team.key} issue “${title}”, ${assignee ? `assigned to ${assignee.name}` : 'unassigned'}, in ${state.name}`,
        ];
      }
      case 'delete':
        return ['Delete it'];
      case 'create-event': {
        const { kind, title, attendees = [] } = action.event;
        if (kind === 'meeting') {
          return attendees.length
            ? [
                `Put “${title}” in your calendar and invite ${attendees.map((guest) => guest.email).join(', ')}`,
              ]
            : [`Put “${title}” in your calendar`];
        }
        return kind === 'focus-block'
          ? [`Put “${title}” in your Commander calendar, busy and private`]
          : ['Put a private Busy copy on your other calendar'];
      }
      case 'update': {
        const { status, title, filing, people, detail } = action.changes;
        // A Todo's due day (#196).
        const due = detail?.kind === 'todo' ? detail.dueOn : undefined;
        return [
          ...(status ? [`Mark it ${status}`] : []),
          ...(due ? [`Make it due ${dueWords(due)}`] : due === null ? ['Take its due day away'] : []),
          ...(title !== undefined ? [`Rename it “${title}”`] : []),
          ...(filing
            ? [`File it under ${projectName(filing.projectId) ?? filing.projectId}`]
            : filing === null
              ? ['Unfile it']
              : []),
          ...(people ? [`Set the people to ${people.join(', ') || 'nobody'}`] : []),
        ];
      }
      case 'edit-fields': {
        // A reply to a Teams Chat (#110), in full: what the User sends if they accept.
        const message = Object.entries(action.fields).find(([field]) => field.startsWith(MESSAGE_FIELD))?.[1];
        const sent = chatReply.safeParse(message);
        if (sent.success) return [`Send this reply in Teams: “${sent.data.text}”`];
        const reply = REPLIES[String(action.fields.response)];
        if (!reply)
          return Object.entries(action.fields).map(
            ([field, value]) => fieldLine(field, value) ?? `Change its ${field}`,
          );
        return [action.fields.seriesResponse ? reply[1] : reply[0]];
      }
      case 'change-setting':
        // One of Ares's own settings (#197), in Commander's words from when it was prepared.
        return [`Change ${action.name} from ${action.fromWords} to ${action.toWords}`];
      default:
        return [];
    }
  });
  if (lines.length) return lines;
  return actions.map((action) =>
    'linkType' in action ? `${action.type === 'unlink' ? 'Remove' : 'Add'} a Link (${action.linkType})` : '',
  );
}

/** Where a line stands, in a few words. */
export function describeActivity(row: AresActivity): string {
  switch (row.status) {
    case 'pending':
      return 'Waiting for you';
    case 'dismissed':
      return 'Dismissed';
    case 'accepted':
    case 'done': {
      const who = row.status === 'done' ? 'Done by Ares' : 'Accepted by you';
      // A settings change no longer undoable because the setting changed again isn't undone (#197).
      return row.undoable || (isSettingChange(row) && !row.undone) ? who : `${who} · undone`;
    }
  }
}
