// The User's side of Ares's filing (#71), for the window: answering the dashed Badge, reading his
// filing record, and settling suggestions the User or a Rule has since overruled.
//
// - Confirm (the suggested Project) accepts the suggestion through the gate: the Item is filed by the
//   User. Change to another Project files it there by the User and dismisses the suggestion; Unfiled
//   turns it down. The Item store records each answer as a confirmation or a correction.
// - A suggestion whose Item the User or a Rule filed since is no longer Ares's to make (Rules always
//   win over his judgement, and he never re-files the User's filing): it is dismissed.
import {
  type ActionContext,
  FILE_INTO_PROJECTS,
  type FilingRecord,
  type ProposalRecord,
} from '@commander/domain';
import { type Gate, GateError } from '../autonomy/gate';
import type { ItemStore } from '../item-store';
import { staleFilingSuggestions } from './file-into-projects';

const user: ActionContext = { by: { kind: 'user' } };

export type Filing = {
  // The User's answer to a filing suggestion: its Project (Confirm), another (Change), or null
  // (Unfiled). Returns the suggestion as settled and the filing entry (for Undo), if one was made.
  settle(proposalId: number, projectId: string | null): { proposal: ProposalRecord; entryId: number | null };
  record(): FilingRecord;
  // Dismisses the suggestions overruled since; returns their ids.
  dismissStale(): number[];
};

export function createFiling({
  itemStore,
  gate,
}: {
  itemStore: ItemStore;
  gate: Pick<Gate, 'accept' | 'dismiss'>;
}): Filing {
  return {
    settle(proposalId, projectId) {
      const record = itemStore.autonomy.proposal(proposalId);
      if (!record || record.action !== FILE_INTO_PROJECTS) {
        throw new GateError('not-found', `No filing suggestion ${proposalId}`);
      }
      if (record.status !== 'pending') {
        throw new GateError(
          'not-pending',
          `Suggestion ${proposalId} is no longer waiting (${record.status})`,
        );
      }
      const step = record.itemActions[0];
      const suggested = step?.type === 'update' ? step.changes.filing?.projectId : undefined;
      if (projectId === suggested) {
        const proposal = gate.accept(proposalId);
        return { proposal, entryId: proposal.entryIds[0] ?? null };
      }
      let entryId: number | null = null;
      if (projectId) {
        entryId = itemStore.record(
          { type: 'update', itemId: record.itemId, changes: { filing: { projectId, filedBy: 'user' } } },
          user,
        ).id;
      } else if (suggested) {
        itemStore.filing.decline(record.itemId, suggested, user);
      }
      return { proposal: gate.dismiss(proposalId), entryId };
    },

    record: () => itemStore.filing.record(),

    dismissStale() {
      const stale = staleFilingSuggestions(itemStore);
      for (const id of stale) gate.dismiss(id);
      return stale;
    },
  };
}
