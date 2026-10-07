// The gate's side of the Item store: the User's Autonomy settings, and Ares's proposals that the gate
// kept (pending suggestions on their Items, and what he carried out). It shares the Item store's
// database, so the Item store stays its only writer. The gate (../autonomy) decides; this stores.
import {
  type AutonomySettings,
  autonomySettings,
  type CausedBy,
  DEFAULT_AUTONOMY,
  type ProposalQuery,
  type ProposalRecord,
  type ProposalStatus,
  proposalQuery,
} from '@commander/domain';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type NewProposal = Omit<ProposalRecord, 'id' | 'at' | 'settledAt'>;

export type AutonomyStore = {
  // The saved settings; anything unreadable falls back to the defaults.
  settings(): AutonomySettings;
  // Validates, saves and returns the settings. Hard limits are the gate's to enforce.
  saveSettings(settings: AutonomySettings): AutonomySettings;
  saveProposal(proposal: NewProposal): ProposalRecord;
  // Marks a proposal accepted, dismissed or done, with the activity entries carrying it out recorded.
  settleProposal(proposalId: number, settled: { status: ProposalStatus; entryIds: number[] }): ProposalRecord;
  proposal(proposalId: number): ProposalRecord | null;
  // Newest first.
  proposals(query?: ProposalQuery): ProposalRecord[];
};

type ProposalRow = typeof schema.proposals.$inferSelect;

function toProposal(row: ProposalRow): ProposalRecord {
  const { causedByItemId, causedByEntryId, conversationId, conversationTurnId, ...rest } = row;
  let causedBy: CausedBy | null = null;
  if (causedByItemId || causedByEntryId) {
    causedBy = {};
    if (causedByItemId) causedBy.itemId = causedByItemId;
    if (causedByEntryId) causedBy.entryId = causedByEntryId;
  }
  const conversation =
    conversationId && conversationTurnId ? { conversationId, turnId: conversationTurnId } : null;
  return { ...rest, causedBy, conversation };
}

export function openAutonomyStore(
  db: BetterSQLite3Database<typeof schema>,
  now: () => number,
): AutonomyStore {
  const { autonomySettings: settingsTable, proposals } = schema;

  return {
    settings() {
      const row = db.select().from(settingsTable).where(eq(settingsTable.id, 1)).get();
      const stored = autonomySettings.safeParse(row?.settings);
      if (!stored.success) return DEFAULT_AUTONOMY;
      return { ...stored.data, everywhere: { ...DEFAULT_AUTONOMY.everywhere, ...stored.data.everywhere } };
    },

    saveSettings(input) {
      const settings = autonomySettings.parse(input);
      const updatedAt = now();
      db.insert(settingsTable)
        .values({ id: 1, settings, updatedAt })
        .onConflictDoUpdate({ target: settingsTable.id, set: { settings, updatedAt } })
        .run();
      return settings;
    },

    saveProposal({ causedBy, conversation, ...proposal }) {
      const row = db
        .insert(proposals)
        .values({
          ...proposal,
          causedByItemId: causedBy?.itemId ?? null,
          causedByEntryId: causedBy?.entryId ?? null,
          conversationId: conversation?.conversationId ?? null,
          conversationTurnId: conversation?.turnId ?? null,
          at: now(),
          settledAt: null,
        })
        .returning()
        .get();
      return toProposal(row);
    },

    settleProposal(proposalId, { status, entryIds }) {
      const row = db
        .update(proposals)
        .set({ status, entryIds, settledAt: now() })
        .where(eq(proposals.id, proposalId))
        .returning()
        .get();
      if (!row) throw new Error(`No proposal ${proposalId}`);
      return toProposal(row);
    },

    proposal(proposalId) {
      const row = db.select().from(proposals).where(eq(proposals.id, proposalId)).get();
      return row ? toProposal(row) : null;
    },

    proposals(input = {}) {
      const query = proposalQuery.parse(input);
      return db
        .select()
        .from(proposals)
        .where(
          and(
            query.ids ? inArray(proposals.id, query.ids) : undefined,
            query.itemId ? eq(proposals.itemId, query.itemId) : undefined,
            query.action ? eq(proposals.action, query.action) : undefined,
            query.actionKinds ? inArray(proposals.actionKind, query.actionKinds) : undefined,
            query.section ? eq(proposals.section, query.section) : undefined,
            query.statuses ? inArray(proposals.status, query.statuses) : undefined,
            query.entryId
              ? sql`EXISTS (SELECT 1 FROM json_each(${proposals.entryIds}) WHERE value = ${query.entryId})`
              : undefined,
          ),
        )
        .orderBy(desc(proposals.id))
        .limit(query.limit ?? 200)
        .all()
        .map(toProposal);
    },
  };
}
