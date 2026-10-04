// The gate every Ares action goes through. Ares's jobs hand it proposals; it decides, from the
// User's Autonomy settings and the hard limits, whether each is dropped, kept as a suggestion on its
// Item for the User to accept, or carried out as Ares through the Item store, logged and undoable.
// Ares never writes to the database himself.
import {
  ACTION_KIND_NAMES,
  type ActionContext,
  type AresActivity,
  AUTONOMY_LEVEL_NAMES,
  type AutonomyLevel,
  type AutonomySettings,
  type AutonomyTarget,
  autonomyTarget,
  decide,
  HARD_LIMITS,
  isAllowed,
  type Proposal,
  type ProposalOutcome,
  type ProposalQuery,
  type ProposalRecord,
  proposal as proposalSchema,
  type RegisteredAction,
  registeredAction,
  type StepTarget,
} from '@commander/domain';
import type { ItemStore } from '../item-store';

export type Gate = {
  // Jobs register each action they propose, with its Action kind, so the Settings grid can list it.
  registerAction(action: RegisteredAction): void;
  actions(): RegisteredAction[];
  settings(): AutonomySettings;
  // Sets one cell of the Settings grid. null clears a Section or per-action override.
  setLevel(target: AutonomyTarget, level: AutonomyLevel | null): AutonomySettings;
  propose(proposal: Proposal): ProposalOutcome;
  // The User accepts a pending suggestion: it is carried out, as the User, with Ares's reason and
  // its cause. Nothing further happens by itself: each next step is a fresh proposal.
  accept(proposalId: number): ProposalRecord;
  dismiss(proposalId: number): ProposalRecord;
  // Accepts several at once: only Organise and Tidy your Sources suggestions, and all or none.
  acceptAll(proposalIds: number[]): ProposalRecord[];
  // Reverses everything an automatic (or accepted) proposal did, while that is still possible.
  undo(proposalId: number): AresActivity;
  // Everything Ares did or suggested, newest first.
  activity(query?: ProposalQuery): AresActivity[];
};

export class GateError extends Error {
  constructor(
    readonly code:
      | 'unknown-action'
      | 'invalid'
      | 'not-found'
      | 'not-pending'
      | 'bulk-refused'
      | 'not-undoable',
    message: string,
  ) {
    super(message);
    this.name = 'GateError';
  }
}

const ares: ActionContext['by'] = { kind: 'ares' };
const user: ActionContext['by'] = { kind: 'user' };
// Suggestions of these kinds are only ever accepted one at a time.
const ONE_AT_A_TIME = new Set(['act-for-you', 'delete']);

// `onChange` hears of every change to Ares's activity, with the Items it changed (none for a
// suggestion kept or dismissed), so open views can catch up.
export function openGate({
  itemStore,
  onChange,
}: {
  itemStore: ItemStore;
  onChange?: (itemIds: string[]) => void;
}): Gate {
  const registered = new Map<string, RegisteredAction>();

  const settings = () => itemStore.autonomy.settings();

  function requireAction(action: string): RegisteredAction {
    const found = registered.get(action);
    if (!found) throw new GateError('unknown-action', `The action "${action}" is not registered`);
    return found;
  }

  // Checks that every { step } target points at an Item an earlier step creates.
  function checkSteps(parsed: ReturnType<typeof proposalSchema.parse>) {
    const check = (target: StepTarget, index: number) => {
      if (typeof target === 'string') return;
      const step = parsed.itemActions[target.step];
      if (target.step >= index || step?.type !== 'create') {
        throw new GateError(
          'invalid',
          `Step ${index} points at step ${target.step}, which creates no Item before it`,
        );
      }
    };
    parsed.itemActions.forEach((action, index) => {
      if ('itemId' in action) check(action.itemId, index);
      if ('from' in action) {
        check(action.from, index);
        check(action.to, index);
      }
    });
  }

  // A proposal's steps must fit its Action kind, so no kind can carry a stricter one past the hard
  // limits: any delete step makes it Delete, and Organise stays inside Commander (it may file an
  // outside Item, but changes to what syncs back to a Source are at least Tidy your Sources).
  // Steps that don't fit are refused rather than escalated, so a job bug or steered output fails
  // loudly instead of turning into a suggestion of another kind.
  function checkStepsFitKind(parsed: ReturnType<typeof proposalSchema.parse>, action: RegisteredAction) {
    const refuse = (what: string, kind: keyof typeof ACTION_KIND_NAMES) => {
      throw new GateError(
        'invalid',
        `"${action.name}" ${what}, which is ${ACTION_KIND_NAMES[kind]}, not ${ACTION_KIND_NAMES[action.actionKind]}`,
      );
    };
    for (const step of parsed.itemActions) {
      if (step.type === 'delete' && action.actionKind !== 'delete') refuse('deletes', 'delete');
      if (step.type !== 'update' || action.actionKind !== 'organise') continue;
      if (typeof step.itemId !== 'string') continue; // an Item this proposal creates is Commander's own
      const fromSource = itemStore.get(step.itemId)?.item.source != null;
      const syncedChanges = Object.keys(step.changes).filter((field) => field !== 'filing');
      if (fromSource && syncedChanges.length) refuse('changes an Item at its Source', 'tidy-sources');
    }
  }

  // Carries out a proposal's Item actions, in order, as one change. Returns the entries recorded.
  function carryOut(record: ProposalRecord, by: ActionContext['by']): number[] {
    const context: ActionContext = { by, why: record.reason, causedBy: record.causedBy ?? undefined };
    const createdIds: string[] = [];
    const resolve = (target: StepTarget) =>
      typeof target === 'string' ? target : (createdIds[target.step] as string);
    const entryIds: number[] = [];
    const steps: ProposalRecord['itemActions'] = [...record.itemActions];
    // A cause in another Item is linked from the Item acted on, so each shows the other.
    const causeItem = record.causedBy?.itemId;
    if (causeItem && causeItem !== record.itemId) {
      steps.push({ type: 'link', from: record.itemId, linkType: 'caused-by', to: causeItem });
    }
    for (const action of steps) {
      let entry: ReturnType<ItemStore['record']>;
      switch (action.type) {
        case 'create':
          entry = itemStore.record(action, context);
          break;
        case 'update':
          entry = itemStore.record({ ...action, itemId: resolve(action.itemId) }, context);
          break;
        case 'delete':
          entry = itemStore.record({ ...action, itemId: resolve(action.itemId) }, context);
          break;
        default:
          entry = itemStore.record(
            { ...action, from: resolve(action.from), to: resolve(action.to) },
            context,
          );
      }
      createdIds.push(entry.itemId);
      entryIds.push(entry.id);
    }
    return entryIds;
  }

  function requirePending(proposalId: number): ProposalRecord {
    const record = itemStore.autonomy.proposal(proposalId);
    if (!record) throw new GateError('not-found', `No suggestion ${proposalId}`);
    if (record.status !== 'pending') {
      throw new GateError('not-pending', `Suggestion ${proposalId} is no longer waiting (${record.status})`);
    }
    return record;
  }

  function acceptOne(proposalId: number): ProposalRecord {
    const record = requirePending(proposalId);
    return itemStore.autonomy.settleProposal(record.id, {
      status: 'accepted',
      entryIds: carryOut(record, user),
    });
  }

  // Whether a proposal follows from something a chained suggestion did: then it is chained too, so
  // a chain never continues on its own.
  function followsAChain(entryId: number | undefined): boolean {
    if (!entryId) return false;
    return itemStore.autonomy.proposals({ entryId }).some((record) => record.chained);
  }

  // The Items these activity entries changed (both ends of a Link).
  function itemsOf(entryIds: readonly number[]): string[] {
    const ids = new Set<string>();
    for (const entryId of entryIds) {
      const entry = itemStore.entry(entryId);
      if (entry) ids.add(entry.itemId);
      if (entry?.otherItemId) ids.add(entry.otherItemId);
    }
    return [...ids];
  }

  function changed<T>(result: T, entryIds: readonly number[] = []): T {
    onChange?.(itemsOf(entryIds));
    return result;
  }

  function toActivity(record: ProposalRecord, undone: Set<number>): AresActivity {
    const ref = (id: string | undefined) => {
      const item = id ? itemStore.get(id)?.item : undefined;
      return item
        ? { id: item.id, kind: item.kind, title: item.title, source: item.source, deletedAt: item.deletedAt }
        : null;
    };
    // The cause's Item: the one named, else the Item the causing activity entry changed.
    let cause: AresActivity['cause'] = null;
    if (record.causedBy) {
      const entry = record.causedBy.entryId ? itemStore.entry(record.causedBy.entryId) : null;
      cause = { item: ref(record.causedBy.itemId ?? entry?.itemId), entry };
    }
    const carriedOut = record.status === 'done' || record.status === 'accepted';
    return {
      ...record,
      name: registered.get(record.action)?.name ?? record.action,
      item: ref(record.itemId),
      cause,
      undoable: carriedOut && record.entryIds.length > 0 && !record.entryIds.some((id) => undone.has(id)),
    };
  }

  return {
    registerAction(input) {
      const action = registeredAction.parse(input);
      registered.set(action.action, action);
    },

    actions() {
      return [...registered.values()];
    },

    settings,

    setLevel(rawTarget, level) {
      const target = autonomyTarget.parse(rawTarget);
      const kind = target.scope === 'action' ? requireAction(target.action).actionKind : target.actionKind;
      if (level && !isAllowed(kind, level)) {
        throw new GateError(
          'invalid',
          `${ACTION_KIND_NAMES[kind]} can’t go above ${AUTONOMY_LEVEL_NAMES[HARD_LIMITS[kind]]}`,
        );
      }
      const next = structuredClone(settings());
      if (target.scope === 'everywhere') {
        if (!level) throw new GateError('invalid', 'Everywhere always has a level');
        next.everywhere[target.actionKind] = level;
      } else if (target.scope === 'section') {
        const section = { ...next.sections[target.section] };
        if (level) section[target.actionKind] = level;
        else delete section[target.actionKind];
        next.sections[target.section] = section;
      } else if (level) {
        next.actions[target.action] = level;
      } else {
        delete next.actions[target.action];
      }
      return itemStore.autonomy.saveSettings(next);
    },

    propose(input) {
      const parsed = proposalSchema.parse(input);
      const action = requireAction(parsed.action);
      if (action.actionKind !== parsed.actionKind) {
        throw new GateError(
          'invalid',
          `"${action.name}" is ${ACTION_KIND_NAMES[action.actionKind]}, not ${ACTION_KIND_NAMES[parsed.actionKind]}`,
        );
      }
      checkSteps(parsed);
      checkStepsFitKind(parsed, action);
      if (!itemStore.get(parsed.itemId)) throw new GateError('not-found', `No Item ${parsed.itemId}`);
      if (followsAChain(parsed.causedBy?.entryId)) parsed.chained = true;

      const decision = decide(parsed, settings());
      if (decision === 'off') return { decision };

      const outcome = itemStore.transaction((): ProposalOutcome => {
        const saved = itemStore.autonomy.saveProposal({
          ...parsed,
          causedBy: parsed.causedBy ?? null,
          decision,
          status: 'pending',
          entryIds: [],
        });
        if (decision === 'ask') return { decision, suggestion: saved };
        const entryIds = carryOut(saved, ares);
        return { decision, done: itemStore.autonomy.settleProposal(saved.id, { status: 'done', entryIds }) };
      });
      return changed(outcome, outcome.decision === 'auto' ? outcome.done.entryIds : []);
    },

    accept(proposalId) {
      const accepted = itemStore.transaction(() => acceptOne(proposalId));
      return changed(accepted, accepted.entryIds);
    },

    dismiss(proposalId) {
      const record = requirePending(proposalId);
      return changed(itemStore.autonomy.settleProposal(record.id, { status: 'dismissed', entryIds: [] }));
    },

    acceptAll(proposalIds) {
      const records = proposalIds.map(requirePending);
      const refused = records.find((record) => ONE_AT_A_TIME.has(record.actionKind));
      if (refused) {
        throw new GateError(
          'bulk-refused',
          `${ACTION_KIND_NAMES[refused.actionKind]} suggestions are accepted one at a time`,
        );
      }
      const accepted = itemStore.transaction(() => records.map((record) => acceptOne(record.id)));
      return changed(
        accepted,
        accepted.flatMap((record) => record.entryIds),
      );
    },

    undo(proposalId) {
      const record = itemStore.autonomy.proposal(proposalId);
      if (!record) throw new GateError('not-found', `No proposal ${proposalId}`);
      const undone = new Set(itemStore.undone(record.entryIds));
      if (!toActivity(record, undone).undoable) {
        throw new GateError('not-undoable', `What Ares did in proposal ${proposalId} can’t be undone`);
      }
      itemStore.transaction(() => {
        for (const entryId of [...record.entryIds].reverse()) {
          itemStore.record({ type: 'undo', entryId }, { by: user, why: `Undid: ${record.reason}` });
        }
      });
      return changed(toActivity(record, new Set(record.entryIds)), record.entryIds);
    },

    activity(query = {}) {
      const records = itemStore.autonomy.proposals(query);
      const undone = new Set(itemStore.undone(records.flatMap((record) => record.entryIds)));
      return records.map((record) => toActivity(record, undone));
    },
  };
}
