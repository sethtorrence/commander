// The gate every Ares action goes through. Ares's jobs hand it proposals; it decides, from the
// User's Autonomy settings and the hard limits, whether each is dropped, kept as a suggestion on its
// Item for the User to accept, or carried out as Ares through the Item store, logged and undoable.
// Ares never writes to the database himself.
import {
  ACTION_KIND_NAMES,
  type AcceptChanges,
  type ActionContext,
  type AresActivity,
  AUTONOMY_LEVEL_NAMES,
  type AutonomyLevel,
  type AutonomySettings,
  type AutonomyTarget,
  autonomyTarget,
  BUCKET_FIELD,
  CANCEL_SEND_FIELD,
  createdIn,
  DRAFT_FIELD,
  decide,
  HARD_LIMITS,
  isAllowed,
  onlyOwnEmailFields,
  type Proposal,
  type ProposalOutcome,
  type ProposalQuery,
  type ProposalRecord,
  proposal as proposalSchema,
  type RegisteredAction,
  registeredAction,
  SEND_FIELD,
  type StepTarget,
} from '@commander/domain';
import type { ItemStore } from '../item-store';
import { trustOf } from '../safety/trust';

export type Gate = {
  // Jobs register each action they propose, with its Action kind, so the Settings grid can list it.
  registerAction(action: RegisteredAction): void;
  actions(): RegisteredAction[];
  settings(): AutonomySettings;
  // Sets one cell of the Settings grid. null clears a Section or per-action override.
  setLevel(target: AutonomyTarget, level: AutonomyLevel | null): AutonomySettings;
  // `askOnly`: a suggestion at most, whatever the settings (Commander offering what is already held,
  // like the mail in a Bucket just set to skip the inbox, #142).
  propose(proposal: Proposal, options?: { askOnly?: boolean }): ProposalOutcome;
  // The User accepts a pending suggestion: it is carried out, as the User, with Ares's reason and
  // its cause. Nothing further happens by itself: each next step is a fresh proposal. `changes`: what
  // the User changed on its card first (a proposed meeting's time, guests, Account and calendar).
  accept(proposalId: number, changes?: AcceptChanges): ProposalRecord;
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
// suggestion kept or dismissed) and the Items whose waiting suggestions changed (a dashed Badge
// shows or goes), so open views can catch up.
export function openGate({
  itemStore,
  onChange,
}: {
  itemStore: ItemStore;
  onChange?: (itemIds: string[], suggestionsOn: string[]) => void;
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
      if (target.step >= index || (step?.type !== 'create' && step?.type !== 'create-event')) {
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
      // Synced fields exist only to write back to a Source. An email's Bucket (#141) and its Snooze
      // (#196) are Commander's own fields, never written back, so sorting and snoozing are Organise.
      if (
        step.type === 'edit-fields' &&
        action.actionKind === 'organise' &&
        !onlyOwnEmailFields(step.fields)
      ) {
        refuse('changes an Item at its Source', 'tidy-sources');
      }
      // A new Linear issue is seen by the people in its team (#11).
      if (step.type === 'send-to-linear' && action.actionKind !== 'act-for-you') {
        refuse('makes a Linear issue', 'act-for-you');
      }
      // An event goes in one of the User's calendars, at its Source.
      if (step.type === 'create-event' && action.actionKind === 'organise') {
        refuse('writes an event to a calendar', 'tidy-sources');
      }
      // An event with guests is seen by them (#11): the Source invites them.
      const guests =
        step.type === 'create-event' ? [...step.event.attendees, ...step.event.guestsToFill] : [];
      if (guests.length && action.actionKind !== 'act-for-you') refuse('invites guests', 'act-for-you');
      if (step.type !== 'update' || action.actionKind !== 'organise') continue;
      if (typeof step.itemId !== 'string') continue; // an Item this proposal creates is Commander's own
      const fromSource = itemStore.get(step.itemId)?.item.source != null;
      const syncedChanges = Object.keys(step.changes).filter((field) => field !== 'filing');
      if (fromSource && syncedChanges.length) refuse('changes an Item at its Source', 'tidy-sources');
    }
  }

  // Ares never writes or sends a message (#11, #138, #143): only the User does, pressing Send in the
  // composer. Sending is Act for you, capped at Ask, but no Suggestion carries it either: his drafts are
  // text the User opens in the composer. So a proposal that would save or send a message (the outgoing
  // changes `draft` and `send`, or take back one Microsoft holds for later, `cancel-send`, #139), make an
  // email, or touch one of the User's drafts (a scheduled message among them) is refused outright,
  // whatever its Action kind and whatever the Autonomy settings say.
  function writesAMessage(steps: ProposalRecord['itemActions']): boolean {
    const isDraft = (target: StepTarget) => {
      if (typeof target !== 'string') return false;
      const detail = itemStore.get(target)?.item.detail;
      return detail?.kind === 'email' && !!detail.draft;
    };
    return steps.some((step) => {
      if (step.type === 'create') return step.item.kind === 'email';
      if (
        step.type === 'edit-fields' &&
        (DRAFT_FIELD in step.fields || SEND_FIELD in step.fields || CANCEL_SEND_FIELD in step.fields)
      )
        return true;
      if ('itemId' in step && isDraft(step.itemId)) return true;
      return 'from' in step && (isDraft(step.from) || isDraft(step.to));
    });
  }

  // Filing precedence (#62, #71): the User's filing, then a Rule's, then Ares's (or inheritance). The
  // update steps that would file an existing Item the User or a Rule filed: Ares never re-files those.
  function overridesFiling(steps: ProposalRecord['itemActions']): boolean {
    return steps.some((step) => {
      if (step.type !== 'update' || typeof step.itemId !== 'string' || step.changes.filing === undefined)
        return false;
      const filedBy = itemStore.get(step.itemId)?.item.filing?.filedBy;
      return filedBy === 'user' || filedBy === 'rule';
    });
  }

  // Sorting precedence (#137, #141): the User's sorting, then a Rule's, then Ares's. The steps that
  // would move an email the User or a Rule sorted: Ares never moves those.
  function overridesSorting(steps: ProposalRecord['itemActions']): boolean {
    return steps.some((step) => {
      if (step.type !== 'edit-fields' || typeof step.itemId !== 'string' || !(BUCKET_FIELD in step.fields))
        return false;
      const detail = itemStore.get(step.itemId)?.item.detail;
      const sortedBy = detail?.kind === 'email' ? detail.bucket?.sortedBy : undefined;
      return sortedBy === 'user' || sortedBy === 'rule';
    });
  }

  // Carries out a proposal's Item actions, in order, as one change. Returns the entries recorded.
  // Accepted by the User, a filing Ares suggested is the User's own: filed by hand from then on.
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
      // Entries a step recorded after its first (what sending to Linear did to the Todo).
      let more: number[] = [];
      switch (action.type) {
        case 'create':
          entry = itemStore.record(action, context);
          break;
        case 'create-event':
          entry = itemStore.createEvent(action.event, context);
          break;
        case 'send-to-linear': {
          // Send to Linear's own entries: the issue made first, then what it did to the Todo or Block.
          const entries = itemStore.sendToLinear(action.draft, context);
          const [made, ...rest] = entries;
          if (!made) throw new GateError('invalid', 'Sending to Linear made no issue');
          entry = made;
          more = rest.map((each) => each.id);
          break;
        }
        case 'update': {
          const { filing } = action.changes;
          const changes =
            by.kind === 'user' && filing?.filedBy === 'ares'
              ? { ...action.changes, filing: { ...filing, filedBy: 'user' as const } }
              : action.changes;
          entry = itemStore.record({ ...action, changes, itemId: resolve(action.itemId) }, context);
          break;
        }
        case 'delete':
        case 'edit-fields':
          entry = itemStore.record({ ...action, itemId: resolve(action.itemId) }, context);
          break;
        default:
          entry = itemStore.record(
            { ...action, from: resolve(action.from), to: resolve(action.to) },
            context,
          );
      }
      createdIds.push(entry.itemId);
      entryIds.push(entry.id, ...more);
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

  // The suggestion's steps with the User's changes from its card: its event as changed. Moved to
  // another Account without a calendar named, it goes on that Account's main calendar.
  function withChanges(record: ProposalRecord, changes: AcceptChanges | undefined): ProposalRecord {
    const event = changes?.event;
    if (!event || !Object.keys(event).length) return record;
    if (!record.itemActions.some((step) => step.type === 'create-event')) {
      throw new GateError('invalid', 'That suggestion makes no event to change');
    }
    const itemActions = record.itemActions.map((step) => {
      if (step.type !== 'create-event') return step;
      const { calendarId, ...rest } = event;
      const moved = rest.account !== undefined && rest.account !== step.event.account;
      const calendar = calendarId !== undefined ? calendarId : moved ? null : step.event.calendarId;
      const { calendarId: _was, ...kept } = step.event;
      return {
        ...step,
        event: { ...kept, ...rest, guestsToFill: [], ...(calendar ? { calendarId: calendar } : {}) },
      };
    });
    return { ...record, itemActions: proposalSchema.shape.itemActions.parse(itemActions) };
  }

  function acceptOne(proposalId: number, changes?: AcceptChanges): ProposalRecord {
    const record = requirePending(proposalId);
    // Filed (or sorted) by the User or a Rule since Ares suggested it: his suggestion no longer stands.
    if (overridesFiling(record.itemActions) || overridesSorting(record.itemActions)) {
      return itemStore.autonomy.settleProposal(record.id, { status: 'dismissed', entryIds: [] });
    }
    return itemStore.autonomy.settleProposal(record.id, {
      status: 'accepted',
      entryIds: carryOut(withChanges(record, changes), user),
    });
  }

  // Whether a proposal was caused by outside content (an untrusted Item, or a change a Source made)
  // and reaches beyond the Item that caused it: then it is chained, so it always asks and shows its
  // cause, whatever the job said (#22, #69). Acting on the outside Item itself (filing it, a Todo
  // from it) follows the Autonomy settings.
  function reachesBeyondOutsideCause(parsed: ReturnType<typeof proposalSchema.parse>): boolean {
    const cause = parsed.causedBy;
    if (!cause) return false;
    const entry = cause.entryId ? itemStore.entry(cause.entryId) : null;
    const causeItemId = cause.itemId ?? entry?.itemId;
    const causeItem = causeItemId ? itemStore.get(causeItemId)?.item : undefined;
    const outside = (causeItem && trustOf(causeItem) === 'untrusted') || entry?.by.kind === 'source';
    if (!outside) return false;
    // An event made from an email (#144) is another Item, in the User's calendar: never the email's
    // own, so always chained. (A Busy copy of an event is that event's own, #131.)
    if (
      causeItem?.kind === 'email' &&
      parsed.itemActions.some((step) => step.type === 'create-event' && !step.event.copyOf)
    )
      return true;
    const touched = new Set([parsed.itemId]);
    const touch = (target: StepTarget) => typeof target === 'string' && touched.add(target);
    for (const step of parsed.itemActions) {
      if ('itemId' in step) touch(step.itemId);
      if ('from' in step) {
        touch(step.from);
        touch(step.to);
      }
      if (step.type === 'create') for (const target of createdIn(step.item.detail)) touch(target);
      if (step.type === 'create-event' && step.event.copyOf) touch(step.event.copyOf);
      if (step.type === 'send-to-linear' && step.draft.from) touch(step.draft.from);
    }
    return [...touched].some((itemId) => itemId !== causeItemId);
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

  function changed<T>(result: T, entryIds: readonly number[] = [], suggestionsOn: string[] = []): T {
    onChange?.(itemsOf(entryIds), suggestionsOn);
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
    // The Conversation it was asked for in (#196), by its name while it is still kept.
    const asked = record.conversation;
    const conversation = asked
      ? { ...asked, title: itemStore.conversations.conversation(asked.conversationId)?.title ?? null }
      : null;
    return {
      ...record,
      name: registered.get(record.action)?.name ?? record.action,
      item: ref(record.itemId),
      cause,
      conversation,
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

    propose(input, { askOnly = false } = {}) {
      const parsed = proposalSchema.parse(input);
      const action = requireAction(parsed.action);
      if (action.actionKind !== parsed.actionKind) {
        throw new GateError(
          'invalid',
          `"${action.name}" is ${ACTION_KIND_NAMES[action.actionKind]}, not ${ACTION_KIND_NAMES[parsed.actionKind]}`,
        );
      }
      if (writesAMessage(parsed.itemActions)) {
        throw new GateError(
          'invalid',
          'Ares never writes or sends a message: only you do, from the composer',
        );
      }
      checkSteps(parsed);
      checkStepsFitKind(parsed, action);
      if (overridesFiling(parsed.itemActions)) {
        throw new GateError('invalid', 'Ares never re-files an Item you or a Rule filed');
      }
      if (overridesSorting(parsed.itemActions)) {
        throw new GateError('invalid', 'Ares never moves an email you or a Rule sorted');
      }
      if (!itemStore.get(parsed.itemId)) throw new GateError('not-found', `No Item ${parsed.itemId}`);
      if (followsAChain(parsed.causedBy?.entryId) || reachesBeyondOutsideCause(parsed)) parsed.chained = true;

      const decided = decide(parsed, settings());
      const decision = askOnly && decided === 'auto' ? 'ask' : decided;
      if (decision === 'off') return { decision };

      const outcome = itemStore.transaction((): ProposalOutcome => {
        const saved = itemStore.autonomy.saveProposal({
          ...parsed,
          causedBy: parsed.causedBy ?? null,
          conversation: parsed.conversation ?? null,
          decision,
          status: 'pending',
          entryIds: [],
        });
        if (decision === 'ask') return { decision, suggestion: saved };
        const entryIds = carryOut(saved, ares);
        return { decision, done: itemStore.autonomy.settleProposal(saved.id, { status: 'done', entryIds }) };
      });
      return changed(outcome, outcome.decision === 'auto' ? outcome.done.entryIds : [], [parsed.itemId]);
    },

    accept(proposalId, changes) {
      const accepted = itemStore.transaction(() => acceptOne(proposalId, changes));
      return changed(accepted, accepted.entryIds, [accepted.itemId]);
    },

    dismiss(proposalId) {
      const record = requirePending(proposalId);
      return changed(
        itemStore.autonomy.settleProposal(record.id, { status: 'dismissed', entryIds: [] }),
        [],
        [record.itemId],
      );
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
        accepted.map((record) => record.itemId),
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
