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

/** What a proposal does (or would do), one plain line per change, so it can be judged before accepting. */
export function describeItemActions(actions: ProposedItemAction[]): string[] {
  const lines = actions.flatMap((action): string[] => {
    switch (action.type) {
      case 'create':
        return [`Add the ${KIND_NAMES[action.item.kind] ?? action.item.kind} “${action.item.title}”`];
      case 'delete':
        return ['Delete it'];
      case 'update': {
        const { status, title, filing, people } = action.changes;
        return [
          ...(status ? [`Mark it ${status}`] : []),
          ...(title !== undefined ? [`Rename it “${title}”`] : []),
          ...(filing ? [`File it under ${filing.projectId}`] : filing === null ? ['Unfile it'] : []),
          ...(people ? [`Set the people to ${people.join(', ') || 'nobody'}`] : []),
        ];
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
