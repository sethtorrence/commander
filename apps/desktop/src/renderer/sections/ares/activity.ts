import type {
  ActionKind,
  AresActivity,
  AutonomySection,
  ItemKind,
  ProposedItemAction,
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

/** Organise and Tidy your Sources suggestions can be accepted all at once; the others one at a time. */
export function bulkAcceptable(kind: ActionKind): boolean {
  return kind === 'organise' || kind === 'tidy-sources';
}

const KIND_NAMES: Partial<Record<ItemKind, string>> = { todo: 'Todo', block: 'Block', event: 'event' };

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
      case 'create':
        return [`Add the ${KIND_NAMES[action.item.kind] ?? action.item.kind} “${action.item.title}”`];
      case 'delete':
        return ['Delete it'];
      case 'create-event':
        return action.event.kind === 'focus-block'
          ? [`Put “${action.event.title}” in your Commander calendar, busy and private`]
          : ['Put a private Busy copy on your other calendar'];
      case 'update': {
        const { status, title, filing, people } = action.changes;
        return [
          ...(status ? [`Mark it ${status}`] : []),
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
        const reply = REPLIES[String(action.fields.response)];
        if (!reply) return Object.keys(action.fields).map((field) => `Change its ${field}`);
        return [action.fields.seriesResponse ? reply[1] : reply[0]];
      }
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
      return row.undoable ? who : `${who} · undone`;
    }
  }
}
