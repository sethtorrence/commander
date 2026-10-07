// Settings → Diagnostics and Export diagnostics (#207), the Core's side: recent sync runs, where each
// Account's syncing stands, the database's version and the settings that aren't secret; and, for the
// export, which of its lines hold a token or key the Core was handed (they are left out).
//
// Nothing here says what an Item says: runs carry counts and the plain reason a sync failed, statuses
// what Settings → Accounts shows, changes that couldn't sync (#206) only their count and latest reason
// (never what they were or on which Item), and the settings are Ares's models and cap (API keys live
// in the keyring) and the Autonomy settings.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AccountSyncStatus,
  type BackupsStatus,
  type CoreDiagnosticsReply,
  coreDiagnosticsRequest,
  type DiagnosticsReport,
} from '@commander/domain';
import type { ItemStore } from '../item-store';
import type { KnownSecrets } from '../safety/known-secrets';

// The runs Settings → Diagnostics and the export list.
export const RECENT_RUNS = 30;

/** The newest migration in the folder (the journal's last), or null when it can't be read. */
export function latestMigration(migrationsFolder: string): string | null {
  try {
    const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
      entries?: { tag?: string }[];
    };
    return journal.entries?.at(-1)?.tag ?? null;
  } catch {
    return null;
  }
}

export function setUpDiagnostics({
  store,
  migrationsFolder,
  statuses,
  snapshots,
  secrets,
  send,
}: {
  store: Pick<ItemStore, 'syncState' | 'models' | 'autonomy' | 'migrated' | 'outgoingEntries'>;
  migrationsFolder: string;
  // Where each Account's syncing stands (the sync engine's statuses).
  statuses: () => AccountSyncStatus[];
  // The snapshots kept and any that failed (backups).
  snapshots: () => Pick<BackupsStatus, 'snapshots' | 'problems'>;
  secrets: Pick<KnownSecrets, 'foundIn'>;
  send: (message: CoreDiagnosticsReply) => void;
}) {
  const migration = latestMigration(migrationsFolder);

  // Changes that couldn't sync (#206), from the queue Settings → Accounts lists: how many per Account
  // and Source, and the latest reason.
  function couldntSync(): DiagnosticsReport['couldntSync'] {
    const counted = new Map<string, DiagnosticsReport['couldntSync'][number] & { madeAt: number }>();
    for (const entry of store.outgoingEntries()) {
      if (entry.status !== 'failed') continue;
      const key = `${entry.account}\n${entry.source}`;
      const seen = counted.get(key);
      if (!seen) {
        counted.set(key, {
          account: entry.account,
          source: entry.source,
          count: 1,
          error: entry.error,
          madeAt: entry.madeAt,
        });
        continue;
      }
      seen.count += 1;
      if (entry.madeAt >= seen.madeAt)
        Object.assign(seen, { error: entry.error ?? seen.error, madeAt: entry.madeAt });
    }
    return [...counted.values()].map(({ madeAt: _madeAt, ...each }) => each);
  }

  function report(): DiagnosticsReport {
    const models = store.models.settings();
    const backups = snapshots();
    return {
      runs: store.syncState
        .recentRuns(RECENT_RUNS)
        .map(({ id: _id, complexity: _complexity, ...run }) => run),
      syncs: statuses(),
      database: { migration, migrated: [...store.migrated] },
      couldntSync: couldntSync(),
      snapshots: backups.snapshots,
      snapshotProblems: backups.problems,
      settings: {
        models: {
          tiers: models.tiers,
          jobOverrides: models.jobOverrides,
          monthlyCapUsd: models.monthlyCapUsd,
          deepFallback: models.deepFallback,
          busyChatMessages: models.busyChatMessages ?? null,
          searchByMeaning: models.searchByMeaning ?? null,
          cloudMail: models.cloudMail ?? {},
        },
        autonomy: store.autonomy.settings(),
      },
    };
  }

  return {
    report,
    /** Answers the main process's requests. False for any other message. */
    handle(raw: unknown): boolean {
      const parsed = coreDiagnosticsRequest.safeParse(raw);
      if (!parsed.success) return false;
      const { id, request } = parsed.data;
      if (request.op === 'report') {
        send({ type: 'diagnostics-reply', id, response: { op: 'report', report: report() } });
      } else {
        const held = request.lines.flatMap((line, index) => (secrets.foundIn(line) ? [index] : []));
        send({ type: 'diagnostics-reply', id, response: { op: 'check', held } });
      }
      return true;
    },
  };
}
