// Settings → GitHub (#113): what each GitHub Account watches, kept in the Item store's database so
// the Item store stays its only writer. The selection is a setting, not Items, so saving it is not in
// the activity log; the Items an unwatch removes are, each deleted as the User's change.
import {
  type GitHubAccess,
  type GitHubRepoRef,
  type GitHubWatch,
  githubAccess,
  githubRepoOfExternalId,
  githubWatch,
  type Item,
  knownRepos,
} from '@commander/domain';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type GitHubWatchRecord = {
  // null until the first selection is made.
  watch: GitHubWatch | null;
  // The selection is still the one Commander started with.
  fromDefault: boolean;
  // What GitHub last listed the Account can reach.
  access: GitHubAccess | null;
  // Every repo the Account has listed.
  seen: GitHubRepoRef[];
  addedOrgs: string[];
};

export type GitHubWatchStore = {
  read(account: string): GitHubWatchRecord;
  // The first selection, from what the User worked in lately; never replaces one already made.
  startWith(account: string, watch: GitHubWatch): void;
  // The User's selection. `stop`: the repos it stops watching, whose Items are removed (as the
  // User, saying `why`) in the same transaction. Returns the removed Items' ids.
  save(account: string, watch: GitHubWatch, unwatch?: { stop: GitHubRepoRef[]; why: string }): string[];
  // What GitHub listed the Account can reach; every repo in it is remembered as seen.
  saveAccess(account: string, access: GitHubAccess): void;
  addOrg(account: string, login: string): void;
  // How many live Items the Account has from these repos (by node id).
  countItems(account: string, repoNodeIds: readonly string[]): number;
  // The Account was removed.
  forget(account: string): void;
};

export function githubWatchIn(
  db: BetterSQLite3Database<typeof schema>,
  {
    now,
    transaction,
    liveItems,
    removeItems,
  }: {
    now: () => number;
    transaction: <T>(fn: () => T) => T;
    // The Account's live GitHub Items.
    liveItems: (account: string) => Item[];
    // Deletes these Items as the User, saying why. Returns their ids.
    removeItems: (items: Item[], why: string) => string[];
  },
): GitHubWatchStore {
  const table = schema.githubWatch;
  const row = (account: string) => db.select().from(table).where(eq(table.account, account)).get();

  // Writes some of the Account's row, making it if there isn't one.
  function put(account: string, changes: Partial<Omit<typeof table.$inferInsert, 'account'>>) {
    const updatedAt = now();
    db.insert(table)
      .values({ account, ...changes, updatedAt })
      .onConflictDoUpdate({ target: table.account, set: { ...changes, updatedAt } })
      .run();
  }

  const fromRepos = (account: string, repoNodeIds: readonly string[]) => {
    const ids = new Set(repoNodeIds);
    return liveItems(account).filter((item) => {
      const repo = item.externalId ? githubRepoOfExternalId(item.externalId) : null;
      return repo !== null && ids.has(repo);
    });
  };

  return {
    read(account) {
      const found = row(account);
      // Anything unreadable (an older shape, say) reads as not there.
      const watch = githubWatch.safeParse(found?.watch);
      const access = githubAccess.safeParse(found?.access);
      return {
        watch: watch.success ? watch.data : null,
        fromDefault: watch.success && (found?.fromDefault ?? false),
        access: access.success ? access.data : null,
        seen: found?.seen ?? [],
        addedOrgs: found?.addedOrgs ?? [],
      };
    },

    startWith(account, input) {
      const watch = githubWatch.parse(input);
      transaction(() => {
        if (row(account)?.watch) return;
        put(account, { watch, fromDefault: true });
      });
    },

    save(account, input, unwatch) {
      const watch = githubWatch.parse(input);
      return transaction(() => {
        const removed = unwatch?.stop.length
          ? removeItems(
              fromRepos(
                account,
                unwatch.stop.map((repo) => repo.nodeId),
              ),
              unwatch.why,
            )
          : [];
        put(account, { watch, fromDefault: false });
        return removed;
      });
    },

    saveAccess(account, input) {
      const access = githubAccess.parse(input);
      transaction(() => put(account, { access, seen: knownRepos(access, row(account)?.seen ?? []) }));
    },

    addOrg(account, login) {
      transaction(() => {
        const added = row(account)?.addedOrgs ?? [];
        if (added.some((each) => each.toLowerCase() === login.toLowerCase())) return;
        put(account, { addedOrgs: [...added, login] });
      });
    },

    countItems: (account, repoNodeIds) => fromRepos(account, repoNodeIds).length,

    forget(account) {
      db.delete(table).where(eq(table.account, account)).run();
    },
  };
}
