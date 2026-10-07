/*
  Removing an Account (#204, decision #30): what Commander synced from it goes for good, not only out
  of sight. The Item store first deletes the Account's live Items as one change (tombstones, so the
  User's Notes and Todos keep their Links, shown as gone); this then takes the content out of every
  Item the Account ever gave Commander, tombstones from before included, and out of everything
  Commander made of them:

  - Each Item keeps a bare tombstone: its kind, Source, Account and times, titled in Commander's own
    words (REMOVED_ITEM_TITLE), with no People, Project or detail. Its external id becomes
    `removed:<id>`, so the Account connected again syncs its Items afresh and undo never brings one
    back. Email bodies, the words and meaning indexes, warning marks, refusals, Ares's rankings,
    seen marks, waiting flags, suggested replies and composer records go with their Items.
  - The activity log keeps its entries (who did what, and when), but no copy of the Items' content:
    the states before and after, and the reasons, are emptied. The removal's own delete entries keep
    their reason ("Removed the Gmail Account …").
  - Ares's meeting preps for its events are its content too, and go the same way. Todos stay as they
    are (decision #30), sync's own for its issues included, with nothing behind them.
  - Ares's suggestions about the Items that never took effect go; the reasons of those that did are
    emptied. Memories Ares learned only from the Items go; lines of the Update naming them lose them.
  - In Conversations, a link to an Item reads as gone, and an answer of Ares's resting only on the
    removed Items (all its links, or the Item a Conversation was started from) is replaced by a note;
    what his Skills made from them (drafts, a prep) goes. Each changed turn is indexed again.
  - People handles only the Account's Items named are forgotten (never one the User placed).
  - What the Account kept beside its Items (its catalog, calendars, sync runs, signature) goes.

  The Item store runs with SQLite's secure_delete on, so nothing deleted keeps its bytes in the file;
  `compact` then merges the FTS5 indexes and empties the write-ahead log, so no old index segment or
  logged page still holds the content. Snapshots keep it until they age out: the
  removal dialog says so, and Wipe all Commander data removes everything at once.
*/
import {
  type Item,
  identitiesOf,
  REMOVED_EXTERNAL_ID,
  REMOVED_ITEM_TITLE,
  type Source,
} from '@commander/domain';
import type Database from 'better-sqlite3';
import type { MemoryStore } from '../memory';
import type { SearchableTurn } from '../search/conversation-index';
import type { PeopleStore } from './people';
import type { ItemRow } from './rows';

// Why, in the activity log and on a suggestion that took effect, once the Items it was about are gone.
export const REMOVED_REASON = 'About an Item removed with its Account';
// What stands in for an answer of Ares's that rested only on removed Items.
export const REMOVED_ANSWER = 'This answer was about Items from an Account you removed.';
// What stands in for a line of an Update that named removed Items among others.
export const REMOVED_LINE = 'This line was about Items from an Account you removed.';

const PAGE = 500;

// Every table holding a Source Item's (or Ares's prep's) kind-specific detail, as the Item store's
// writeDetail keeps them.
const DETAIL_TABLES = [
  'linear_issue_details',
  'chat_details',
  'channel_post_details',
  'github_details',
  'email_details',
  'email_message_ids',
  'event_details',
  'meeting_prep_details',
  'github_summary_details',
  'todo_details',
];

export type AccountRemovalDeps = {
  sqlite: Database.Database;
  now: () => number;
  // The Items' rows, by id, and the Items with their detail.
  rows(itemIds: readonly string[]): ItemRow[];
  withDetails(rows: ItemRow[]): Item[];
  // Indexes a Conversation turn again, as it now reads.
  reindexTurn(turn: SearchableTurn): void;
  memory: Pick<MemoryStore, 'dropSources'>;
  people: Pick<PeopleStore, 'forget'>;
};

type TurnRow = {
  id: number;
  conversation_id: string;
  by: SearchableTurn['by'];
  status: SearchableTurn['status'];
  text: string;
  links: string;
  made: string;
  proposal_ids: string;
  about_item_id: string | null;
};

export function accountRemovalIn(deps: AccountRemovalDeps) {
  const { sqlite, now } = deps;
  const all = <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as T[];
  const run = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...params);
  const inRemoved = (column: string) => `${column} IN (SELECT id FROM temp.removed_items)`;

  // The Items removed, in a temporary table (outside the database file) the statements below join.
  function fill(itemIds: readonly string[]) {
    run('CREATE TEMP TABLE IF NOT EXISTS removed_items (id TEXT PRIMARY KEY)');
    run('DELETE FROM temp.removed_items');
    const insert = sqlite.prepare('INSERT OR IGNORE INTO temp.removed_items (id) VALUES (?)');
    for (const id of itemIds) insert.run(id);
  }

  function itemsRemoved(): Item[] {
    const found: Item[] = [];
    for (let after = ''; ; ) {
      const rows = all<{ id: string }>(
        `SELECT id FROM temp.removed_items WHERE id > ? ORDER BY id LIMIT ${PAGE}`,
        after,
      );
      if (!rows.length) return found;
      found.push(...deps.withDetails(deps.rows(rows.map((row) => row.id))));
      after = rows.at(-1)?.id ?? after;
    }
  }

  // The activity log keeps who did what and when, never the content: states and reasons emptied.
  // Entries after `loggedThrough` are the removal's own, and keep their reason.
  function scrubActivity(loggedThrough: number) {
    run(
      `UPDATE activity SET before = NULL, after = NULL, summary = NULL
       WHERE ${inRemoved('item_id')} AND other_item_id IS NULL AND other_project_id IS NULL`,
    );
    run(`UPDATE activity SET why = NULL WHERE ${inRemoved('item_id')} AND id <= ?`, loggedThrough);
  }

  // What Commander kept beside each Item, which goes with it.
  function dropBeside() {
    for (const table of [
      'injection_warnings',
      'refusals',
      'dashboard_rankings',
      'dashboard_clears',
      'agent_seen',
      'chat_waiting',
      'email_compose',
      'email_bodies',
      'outgoing_changes',
    ])
      run(`DELETE FROM ${table} WHERE ${inRemoved('item_id')}`);
    run(`DELETE FROM meeting_chips WHERE ${inRemoved('event_id')}`);
    run(`DELETE FROM suggested_replies WHERE ${inRemoved('answering')} OR ${inRemoved('draft_item_id')}`);
  }

  // Ares's suggestions about the Items: those that never took effect go (and leave whatever names
  // them); those that did lose their reason.
  function settleProposals() {
    const about = `(${inRemoved('item_id')} OR ${inRemoved('caused_by_item_id')})`;
    const gone = all<{ id: number }>(
      `SELECT id FROM proposals WHERE ${about} AND status IN ('pending', 'dismissed')`,
    ).map((row) => row.id);
    run(`UPDATE proposals SET reason = ? WHERE ${about} AND status IN ('accepted', 'done')`, REMOVED_REASON);
    if (!gone.length) return;
    const goneSet = new Set(gone);
    for (let i = 0; i < gone.length; i += PAGE) {
      const chunk = gone.slice(i, i + PAGE);
      const marks = chunk.map(() => '?').join(', ');
      run(`UPDATE agent_seen SET proposal_id = NULL WHERE proposal_id IN (${marks})`, ...chunk);
      run(`DELETE FROM setting_changes WHERE proposal_id IN (${marks})`, ...chunk);
      run(`DELETE FROM proposals WHERE id IN (${marks})`, ...chunk);
    }
    for (const turn of all<{ id: number; proposal_ids: string }>(
      `SELECT id, proposal_ids FROM conversation_turns WHERE proposal_ids <> '[]'`,
    )) {
      const ids = JSON.parse(turn.proposal_ids) as number[];
      const kept = ids.filter((id) => !goneSet.has(id));
      if (kept.length !== ids.length)
        run('UPDATE conversation_turns SET proposal_ids = ? WHERE id = ?', JSON.stringify(kept), turn.id);
    }
    const at = now();
    for (const line of all<{ id: number; about: string; status: string }>(
      `SELECT id, about, status FROM update_queue WHERE json_extract(about, '$.kind') IN ('suggestions', 'chained')`,
    )) {
      const about = JSON.parse(line.about) as { kind: string; proposalIds?: number[]; proposalId?: number };
      if (about.kind === 'chained') {
        if (about.proposalId !== undefined && goneSet.has(about.proposalId)) settleLine(line, null, at);
        continue;
      }
      const ids = about.proposalIds ?? [];
      const kept = ids.filter((id) => !goneSet.has(id));
      if (kept.length === ids.length) continue;
      settleLine(line, kept.length ? { ...about, proposalIds: kept } : null, at);
    }
  }

  // A queued line whose suggestions went: changed to name those left, or settled when none are.
  function settleLine(line: { id: number; status: string }, about: object | null, at: number) {
    if (about) {
      run(
        'UPDATE update_queue SET about = ?, updated_at = ? WHERE id = ?',
        JSON.stringify(about),
        at,
        line.id,
      );
      return;
    }
    if (line.status === 'queued')
      run(`UPDATE update_queue SET status = 'resolved', settled_at = ? WHERE id = ?`, at, line.id);
  }

  // The Update's queue and the Updates given: the Items go from their lines, and a given line that
  // named them loses its sentence (it was about them), or goes when it named nothing else.
  function forgetInUpdates(removedIds: ReadonlySet<string>, titles: ReadonlySet<string>) {
    // A queued line keeps what it says in its own words (an issue's identifier, a change's words): one
    // about nothing but the removed Items goes altogether; one about others too loses the removed ones.
    for (const line of all<{ id: number; item_ids: string; about: string }>(
      `SELECT id, item_ids, about FROM update_queue WHERE item_ids <> '[]'`,
    )) {
      const ids = JSON.parse(line.item_ids) as string[];
      const kept = ids.filter((id) => !removedIds.has(id));
      if (kept.length === ids.length) continue;
      const about = pruned(JSON.parse(line.about) as Record<string, unknown>, removedIds);
      if (!kept.length || !about) {
        run('DELETE FROM update_queue WHERE id = ?', line.id);
        continue;
      }
      run(
        'UPDATE update_queue SET item_ids = ?, about = ? WHERE id = ?',
        JSON.stringify(kept),
        JSON.stringify(about),
        line.id,
      );
    }
    type Line = { itemIds: string[]; sources: string[]; text: string };
    for (const given of all<{ id: number; lines: string }>('SELECT id, lines FROM updates')) {
      const lines = JSON.parse(given.lines) as Line[];
      let changed = false;
      const kept = lines.flatMap((line) => {
        const itemIds = line.itemIds.filter((id) => !removedIds.has(id));
        if (itemIds.length === line.itemIds.length) return [line];
        changed = true;
        if (!itemIds.length) return [];
        return [
          {
            ...line,
            itemIds,
            sources: line.sources.filter((source) => !titles.has(source)),
            text: REMOVED_LINE,
          },
        ];
      });
      if (changed) run('UPDATE updates SET lines = ? WHERE id = ?', JSON.stringify(kept), given.id);
    }
  }

  // Conversations: links to the Items read as gone, an answer resting only on them is replaced, what
  // Skills made from them goes, and a Conversation named after one is renamed. Each turn changed is
  // indexed again.
  function forgetInConversations(removedIds: ReadonlySet<string>, titles: ReadonlyMap<string, string>) {
    const turns = all<TurnRow>(
      `SELECT t.id, t.conversation_id, t.by, t.status, t.text, t.links, t.made, t.proposal_ids,
              c.about_item_id
       FROM conversation_turns t JOIN conversations c ON c.id = t.conversation_id
       WHERE t.links <> '[]' OR t.made <> '[]' OR ${inRemoved('c.about_item_id')}`,
    );
    for (const turn of turns) {
      type Link = { itemId: string; title: string; label: string | null };
      type Made = { itemId?: string; eventId?: string };
      const links = JSON.parse(turn.links) as Link[];
      const made = JSON.parse(turn.made) as Made[];
      const removedLink = (link: Link) => removedIds.has(link.itemId);
      const madeKept = made.filter((each) => !removedIds.has(each.itemId ?? each.eventId ?? ''));
      const aboutRemoved = turn.about_item_id !== null && removedIds.has(turn.about_item_id);
      const onlyRemoved = links.length > 0 && links.every(removedLink);
      let text = turn.text;
      let nextLinks = links;
      if (turn.by === 'ares' && (aboutRemoved || onlyRemoved)) {
        text = REMOVED_ANSWER;
        nextLinks = [];
      } else if (links.some(removedLink)) {
        nextLinks = links.map((link) =>
          removedLink(link) ? { ...link, title: REMOVED_ITEM_TITLE, label: null } : link,
        );
      }
      if (text === turn.text && nextLinks === links && madeKept.length === made.length) continue;
      run(
        'UPDATE conversation_turns SET text = ?, links = ?, made = ? WHERE id = ?',
        text,
        JSON.stringify(nextLinks),
        JSON.stringify(text === REMOVED_ANSWER ? [] : madeKept),
        turn.id,
      );
      deps.reindexTurn({
        id: turn.id,
        conversationId: turn.conversation_id,
        by: turn.by,
        status: turn.status,
        text,
        links: nextLinks as SearchableTurn['links'],
      });
    }
    for (const conversation of all<{ id: string; title: string | null; about_item_id: string }>(
      `SELECT id, title, about_item_id FROM conversations WHERE ${inRemoved('about_item_id')}`,
    )) {
      if (conversation.title !== null && conversation.title === titles.get(conversation.about_item_id))
        run('UPDATE conversations SET title = ? WHERE id = ?', REMOVED_ITEM_TITLE, conversation.id);
    }
  }

  // The bare tombstones: no content of the Account's left in the Items themselves.
  function scrubItems() {
    run(
      `UPDATE items SET title = ?, people = '[]', project_id = NULL, filed_by = NULL,
         external_id = ? || id, deleted_at = COALESCE(deleted_at, ?) WHERE ${inRemoved('id')}`,
      REMOVED_ITEM_TITLE,
      REMOVED_EXTERNAL_ID,
      now(),
    );
    for (const table of DETAIL_TABLES) run(`DELETE FROM ${table} WHERE ${inRemoved('item_id')}`);
  }

  // The handles only the removed Items named: none of the Items left (any Account's, or the User's)
  // names them.
  function unbacked(candidates: Set<string>): string[] {
    for (let after = ''; candidates.size; ) {
      const rows = all<{ id: string }>(
        `SELECT id FROM items WHERE id > ? AND NOT ${inRemoved('id')} ORDER BY id LIMIT ${PAGE}`,
        after,
      );
      if (!rows.length) break;
      for (const item of deps.withDetails(deps.rows(rows.map((row) => row.id))))
        for (const { handle } of identitiesOf(item)) candidates.delete(handle);
      after = rows.at(-1)?.id ?? after;
    }
    return [...candidates];
  }

  // What the Account kept beside its Items.
  function dropAccount({ source, account }: { source: Source; account: string }) {
    for (const table of ['source_catalogs', 'calendars', 'sync_runs', 'sync_state'])
      run(`DELETE FROM ${table} WHERE account = ? AND source = ?`, account, source);
    // Its lines for the Update: Reconnect, and its changes that couldn't sync (#206).
    run(`DELETE FROM update_queue WHERE json_extract(about, '$.account') = ?`, account);
    if (source === 'gmail' || source === 'outlook') {
      run('DELETE FROM email_signatures WHERE account = ?', account);
      run('DELETE FROM suggested_replies WHERE account = ?', account);
      run('UPDATE email_compose_settings SET default_account = NULL WHERE default_account = ?', account);
    }
  }

  return {
    // The Items that go with the Account's own (Ares's preps for its events), by id.
    followers(itemIds: readonly string[]): string[] {
      fill(itemIds);
      const found = all<{ id: string }>(
        `SELECT item_id AS id FROM meeting_prep_details WHERE ${inRemoved('event_id')}`,
      ).map((row) => row.id);
      run('DELETE FROM temp.removed_items');
      return found;
    },

    // Takes the content out of the Items (the Account's, and those that go with them, already
    // deleted, so out of the words and meaning indexes) and everything made of them. `loggedThrough`:
    // the last activity entry from before the removal. Call inside the removal's transaction.
    purge(itemIds: readonly string[], loggedThrough: number, account: { source: Source; account: string }) {
      fill(itemIds);
      try {
        const items = itemsRemoved();
        const removedIds = new Set(items.map((item) => item.id));
        const titles = new Map(items.map((item) => [item.id, item.title]));
        const handles = new Set(items.flatMap((item) => identitiesOf(item).map((each) => each.handle)));
        scrubActivity(loggedThrough);
        settleProposals();
        deps.memory.dropSources([...removedIds]);
        dropBeside();
        forgetInConversations(removedIds, titles);
        forgetInUpdates(removedIds, new Set(titles.values()));
        scrubItems();
        deps.people.forget(unbacked(handles));
        dropAccount(account);
      } finally {
        run('DELETE FROM temp.removed_items');
      }
    },

    // Leaves nothing deleted lingering in the database file. The Item store runs with SQLite's
    // secure_delete on, so every row deleted or rewritten had its old bytes zeroed; what is left is
    // each FTS5 index's deleted entries, still in its older segments until they are merged (done
    // here), and the write-ahead log's copies of the pages before (emptied here). Cheap next to a
    // VACUUM, which would hold the Core for most of a minute on a large database. Outside any
    // transaction; the removal stands even if this fails.
    compact() {
      try {
        const fts = all<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%USING fts5%'`,
        );
        for (const { name } of fts) run(`INSERT INTO "${name}" ("${name}") VALUES ('optimize')`);
        sqlite.pragma('wal_checkpoint(TRUNCATE)');
      } catch (error) {
        console.warn('Could not compact the database after removing an Account:', error);
      }
    },
  };
}

/**
 * A queued line's `about` without the removed Items in its lists (each entry naming one by `itemId`),
 * or null when a list it had is left empty: the line was only about them.
 */
function pruned(about: Record<string, unknown>, removedIds: ReadonlySet<string>) {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(about)) {
    const named = (each: unknown) =>
      typeof each === 'object' && each !== null && typeof (each as { itemId?: unknown }).itemId === 'string';
    if (!Array.isArray(value) || !value.some(named)) {
      next[key] = value;
      continue;
    }
    const kept = value.filter((each) => !named(each) || !removedIds.has((each as { itemId: string }).itemId));
    if (!kept.length) return null;
    next[key] = kept;
  }
  return next;
}

export type AccountRemoval = ReturnType<typeof accountRemovalIn>;
