// The GitHub Section's discussions (#115): a pull request's or issue's comments, reviews and checks,
// fetched on demand and kept beside the Item's detail (github_details.discussion) for the detail's
// `updatedAt` they were fetched for. They are a copy of what GitHub showed, not part of the Item:
// keeping one records nothing in the activity log.
import { type GitHubDiscussion, githubDiscussion, type ItemKind } from '@commander/domain';
import { and, eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type GitHubDiscussionStore = {
  // The discussion last kept for a pull request or issue; null when there is none.
  read(itemId: string): GitHubDiscussion | null;
  // Keeps a pull request's or issue's discussion (anything else is ignored).
  save(itemId: string, discussion: GitHubDiscussion): void;
};

const KINDS: ItemKind[] = ['pull-request', 'github-issue'];

export function githubDiscussionsIn(db: BetterSQLite3Database<typeof schema>): GitHubDiscussionStore {
  const { githubDetails, items } = schema;
  // Only a live pull request's or issue's detail row.
  const ofDiscussable = (itemId: string) =>
    db
      .select({ itemId: githubDetails.itemId, discussion: githubDetails.discussion })
      .from(githubDetails)
      .innerJoin(items, eq(items.id, githubDetails.itemId))
      .where(and(eq(githubDetails.itemId, itemId), inArray(items.kind, KINDS)))
      .get();

  return {
    read(itemId) {
      const row = ofDiscussable(itemId);
      const parsed = githubDiscussion.safeParse(row?.discussion);
      return parsed.success ? parsed.data : null;
    },
    save(itemId, discussion) {
      if (!ofDiscussable(itemId)) return;
      db.update(githubDetails).set({ discussion }).where(eq(githubDetails.itemId, itemId)).run();
    },
  };
}
