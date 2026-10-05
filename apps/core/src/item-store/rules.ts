// The Item store's Rules: one list the User orders, each filing the Items it matches into a Project,
// or sorting the emails it matches into a Bucket (#137).
// They live in the same database, written only through the Item store, but they are not Items: a
// change to the list isn't in the activity log. The Items a Rule files are, with the Rule as actor.
// Matching and wording come from @commander/domain (its per-Source field registry); this module keeps
// the list, its order, and what a merge does to it.
import { randomUUID } from 'node:crypto';
import {
  isEmailRuleField,
  isGroup,
  RULE_FIELDS,
  type Rule,
  type RuleAction,
  type RuleCondition,
  type RuleDraft,
  ruleAction,
} from '@commander/domain';
import { asc, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { z } from 'zod';
import * as schema from './schema';

type RuleRow = typeof schema.rules.$inferSelect;
export type RuleMove = schema.RuleMove;

// What a change did to the list: the Rule as it is now (null once deleted), with the list before and
// after it, so the store can work out which Items it moves.
export type ListChange = { rule: Rule | null; before: Rule[]; after: Rule[] };

export type Rules = {
  // The live Rules in their order: the first is checked first.
  list(): Rule[];
  // Makes one change to the list. Call inside a transaction.
  change(action: RuleAction): ListChange;
  // A merge: every Rule filing into `from` files into `into` instead. Returns what it moved.
  retarget(from: string, into: string): RuleMove[];
  // Undoes moves made by a merge (or by undoing one), skipping Rules changed since. Returns the moves
  // it made, the other way round.
  reverse(moves: readonly RuleMove[]): RuleMove[];
};

function toRule(row: RuleRow): Rule {
  return { id: row.id, target: row.target, when: row.when, order: row.position, createdAt: row.createdAt };
}

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'That Rule isn’t valid';
}

export function rulesIn(
  db: BetterSQLite3Database<typeof schema>,
  now: () => number,
  invalid: (message: string) => Error,
  // Throws unless the Project exists (archived or not).
  checkProject: (projectId: string) => void,
  // Throws unless the Bucket exists (not removed).
  checkBucket: (bucketId: string) => void,
): Rules {
  const { rules } = schema;

  const liveRows = () =>
    db
      .select()
      .from(rules)
      .where(isNull(rules.deletedAt))
      .orderBy(asc(rules.position), asc(rules.createdAt))
      .all();

  const rowById = (id: string) => db.select().from(rules).where(eq(rules.id, id)).get();

  function requireLive(id: string): RuleRow {
    const row = rowById(id);
    if (!row || row.deletedAt !== null) throw invalid(`No Rule ${id}`);
    return row;
  }

  function checkCondition(condition: RuleCondition) {
    const field = RULE_FIELDS.get(condition.field);
    if (!field) throw invalid(`Rules can’t use the field ${condition.field}`);
    if (!field.ops.includes(condition.op)) {
      throw invalid(`A Rule can’t say “${field.name} ${condition.op}”`);
    }
  }

  function checkTarget(target: RuleDraft['target']) {
    if (target.kind === 'project') checkProject(target.projectId);
    else checkBucket(target.bucketId);
  }

  function check(draft: RuleDraft) {
    checkTarget(draft.target);
    const conditions = draft.when.terms.flatMap((term) => (isGroup(term) ? term.conditions : [term]));
    conditions.forEach(checkCondition);
    // A Bucket sorts email only, so its Rules read only what email says.
    if (draft.target.kind === 'bucket' && !conditions.every((each) => isEmailRuleField(each.field)))
      throw invalid('A Bucket Rule can only use email fields (from, domain, subject…)');
  }

  // Writes the live Rules' positions in this order: 0, 1, 2…
  function renumber(ids: readonly string[]) {
    ids.forEach((id, position) => {
      db.update(rules).set({ position }).where(eq(rules.id, id)).run();
    });
  }

  // The live Rule ids with `id` placed at `position` (clamped to the list).
  function placed(id: string, position: number): string[] {
    const rest = liveRows()
      .map((row) => row.id)
      .filter((other) => other !== id);
    rest.splice(Math.max(0, Math.min(rest.length, position)), 0, id);
    return rest;
  }

  function apply(action: z.infer<typeof ruleAction>): string | null {
    const at = now();
    switch (action.type) {
      case 'create': {
        check(action.rule);
        const id = randomUUID();
        const position = action.position ?? liveRows().length;
        db.insert(rules)
          .values({ id, position, ...action.rule, createdAt: at, updatedAt: at })
          .run();
        renumber(placed(id, position));
        return id;
      }
      case 'update': {
        const row = requireLive(action.ruleId);
        check(action.rule);
        db.update(rules)
          .set({ ...action.rule, updatedAt: at })
          .where(eq(rules.id, row.id))
          .run();
        if (action.position !== undefined) renumber(placed(row.id, action.position));
        return row.id;
      }
      case 'move': {
        const row = requireLive(action.ruleId);
        renumber(placed(row.id, action.position));
        return row.id;
      }
      case 'delete': {
        const row = requireLive(action.ruleId);
        db.update(rules).set({ deletedAt: at, updatedAt: at }).where(eq(rules.id, row.id)).run();
        renumber(liveRows().map((other) => other.id));
        return null;
      }
      case 'restore': {
        const row = rowById(action.ruleId);
        if (!row) throw invalid(`No Rule ${action.ruleId}`);
        if (row.deletedAt === null) throw invalid('That Rule isn’t deleted');
        checkTarget(row.target);
        db.update(rules).set({ deletedAt: null, updatedAt: at }).where(eq(rules.id, row.id)).run();
        renumber(placed(row.id, row.position));
        return row.id;
      }
    }
  }

  const list = () => liveRows().map(toRule);

  return {
    list,

    change(input) {
      const parsed = ruleAction.safeParse(input);
      if (!parsed.success) throw invalid(firstIssue(parsed.error));
      const before = list();
      const changed = apply(parsed.data);
      const after = list();
      return { rule: after.find((each) => each.id === changed) ?? null, before, after };
    },

    retarget(from, into) {
      const moves: RuleMove[] = [];
      for (const row of db.select().from(rules).all()) {
        if (row.target.kind !== 'project' || row.target.projectId !== from) continue;
        db.update(rules)
          .set({ target: { ...row.target, projectId: into } })
          .where(eq(rules.id, row.id))
          .run();
        moves.push({ ruleId: row.id, from, to: into });
      }
      return moves;
    },

    reverse(moves) {
      const reversed: RuleMove[] = [];
      for (const move of moves) {
        const row = rowById(move.ruleId);
        if (row?.target.kind !== 'project' || row.target.projectId !== move.to) continue;
        db.update(rules)
          .set({ target: { ...row.target, projectId: move.from } })
          .where(eq(rules.id, row.id))
          .run();
        reversed.push({ ruleId: row.id, from: move.to, to: move.from });
      }
      return reversed;
    },
  };
}
