// The oversight summary in the Item store (#119): Settings → GitHub's oversight settings, the summary
// made from the live GitHub Items and each GitHub Account's repo health (domain oversightSummary), the
// writer's detail kept beside a pull request's detail (github_details.writer_detail) for the
// `updatedAt` it was fetched for, and the lookups finishes Links are made from. Settings and the
// writer's detail are not Items: keeping them records nothing in the activity log.
import {
  defaultOversightSettings,
  type GitHubRepoHealth,
  type GitHubWriterDetail,
  githubCatalog,
  githubPeople,
  githubWriterDetail,
  type IssueRef,
  type Item,
  type ItemKind,
  type OversightRangeSpan,
  type OversightSettings,
  type OversightSettingsInput,
  type OversightSummary,
  oversightSettings,
  oversightSummary,
  type Person,
  type PersonWeek,
  type Project,
} from '@commander/domain';
import { and, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { ItemRow } from './rows';
import * as schema from './schema';

type Db = BetterSQLite3Database<typeof schema>;

export type OversightRequest = { range: OversightRangeSpan; projectId?: string | null };

// A pull request whose writer's detail is missing or older than the pull request.
export type StaleWriterDetail = { itemId: string; account: string; nodeId: string; updatedAt: number };

export type GitHubOversightStore = {
  // Settings → GitHub → Oversight summary: the defaults until the User saves their own.
  settings(): OversightSettings;
  // Validates, saves and returns them (the skill-managed labels, left out, stay as they are).
  saveSettings(settings: OversightSettingsInput): OversightSettings;
  // The summary for a range, over everything, one Project (its id) or Unfiled (null).
  summary(request: OversightRequest): OversightSummary;
  // The People view (#122): each active Person's week for a range and scope, by name; or one
  // Person's, whatever they did.
  people(request: OversightRequest & { personId?: string }): PersonWeek[];
  // The writer's detail last kept for a live pull request; null when there is none.
  writerDetail(itemId: string): GitHubWriterDetail | null;
  // Keeps a live pull request's writer's detail (anything else is ignored).
  saveWriterDetail(itemId: string, detail: GitHubWriterDetail): void;
  // Of these Items, the live pull requests with no writer's detail for their current version.
  staleWriterDetails(itemIds: readonly string[]): StaleWriterDetail[];
  // Live pull requests: these, or every one.
  pullRequests(itemIds?: readonly string[]): Item[];
  // The live Linear issues with these identifiers (any case), by upper-cased identifier.
  linearIssuesNamed(identifiers: readonly string[]): Map<string, string>;
  // The live GitHub issues these refer to.
  githubIssues(refs: readonly IssueRef[]): Item[];
  // Whether a finishes Link from one Item to another was ever made (so a removed one stays removed).
  finishesEverMade(fromItemId: string, toItemId: string): boolean;
};

const CHUNK = 500;
function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < values.length; start += CHUNK) out.push(values.slice(start, start + CHUNK));
  return out;
}

const OVERSIGHT_KINDS: ItemKind[] = ['pull-request', 'github-issue', 'github-release'];

export function githubOversightIn(
  db: Db,
  {
    now,
    withDetails,
    projects,
    people,
  }: {
    now: () => number;
    withDetails: (rows: ItemRow[]) => Item[];
    projects: () => Project[];
    people: () => Person[];
  },
): GitHubOversightStore {
  const { githubDetails, items, githubOversightSettings: table } = schema;

  const settings = (): OversightSettings => {
    const row = db.select().from(table).where(eq(table.id, 1)).get();
    const skillLabels = [...(row?.skillLabels ?? defaultOversightSettings.skillLabels)];
    if (!row) return { ...defaultOversightSettings, bots: [...defaultOversightSettings.bots], skillLabels };
    return { longRunningDays: row.longRunningDays, idleDays: row.idleDays, bots: row.bots, skillLabels };
  };

  const liveOfKinds = (kinds: ItemKind[], itemIds?: readonly string[]): Item[] => {
    const read = (ids?: string[]) =>
      withDetails(
        db
          .select()
          .from(items)
          .where(
            and(
              inArray(items.kind, kinds),
              eq(items.source, 'github'),
              isNull(items.deletedAt),
              ids ? inArray(items.id, ids) : undefined,
            ),
          )
          .all(),
      );
    return itemIds ? chunks(itemIds).flatMap((ids) => read(ids)) : read();
  };

  // Each GitHub Account's watched repos' health (a repo two Accounts watch, once).
  const repoHealth = (): GitHubRepoHealth[] => {
    const rows = db
      .select({ catalog: schema.sourceCatalogs.catalog })
      .from(schema.sourceCatalogs)
      .where(eq(schema.sourceCatalogs.source, 'github'))
      .all();
    const repos = new Map<string, GitHubRepoHealth>();
    for (const row of rows) {
      const parsed = githubCatalog.safeParse(row.catalog);
      if (!parsed.success) continue;
      for (const health of parsed.data.repos) {
        const known = repos.get(health.repo.nodeId);
        if (!known || known.checkedAt < health.checkedAt) repos.set(health.repo.nodeId, health);
      }
    }
    return [...repos.values()];
  };

  const pullRow = (itemId: string) =>
    db
      .select({ itemId: githubDetails.itemId, writerDetail: githubDetails.writerDetail })
      .from(githubDetails)
      .innerJoin(items, eq(items.id, githubDetails.itemId))
      .where(and(eq(githubDetails.itemId, itemId), eq(items.kind, 'pull-request'), isNull(items.deletedAt)))
      .get();

  return {
    settings,

    saveSettings(input) {
      // Left out, the skill-managed labels stay as they are.
      const parsed = oversightSettings.parse({ skillLabels: settings().skillLabels, ...input });
      const unique = (list: string[]) => [...new Set(list.map((each) => each.trim()))];
      const values = {
        longRunningDays: parsed.longRunningDays,
        idleDays: parsed.idleDays,
        bots: unique(parsed.bots),
        skillLabels: unique(parsed.skillLabels),
        updatedAt: now(),
      };
      db.insert(table)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: table.id, set: values })
        .run();
      return settings();
    },

    summary({ range, projectId }) {
      // GitHub logins as their People (#117): `github:<login>` handles, kept lower-cased.
      const byLogin = new Map<string, { id: string; name: string }>();
      for (const person of people())
        for (const { handle } of person.handles)
          if (handle.toLowerCase().startsWith('github:'))
            byLogin.set(handle.slice('github:'.length).toLowerCase(), { id: person.id, name: person.name });
      return oversightSummary({
        personOf: (login) => byLogin.get(login.toLowerCase()) ?? null,
        range,
        ...(projectId !== undefined && { projectId }),
        items: liveOfKinds(OVERSIGHT_KINDS),
        repos: repoHealth(),
        projects: projects().map(({ id, name, code, accent }) => ({ id, name, code, accent })),
        settings: settings(),
      });
    },

    people({ range, projectId, personId }) {
      // Their open Linear issues come through their Linear handles.
      const linear = withDetails(
        db
          .select()
          .from(items)
          .where(and(eq(items.kind, 'linear-issue'), eq(items.status, 'open'), isNull(items.deletedAt)))
          .all(),
      );
      return githubPeople({
        range,
        ...(projectId !== undefined && { projectId }),
        ...(personId !== undefined && { personId }),
        items: [...liveOfKinds(['pull-request']), ...linear],
        people: people(),
        settings: settings(),
      });
    },

    writerDetail(itemId) {
      const parsed = githubWriterDetail.safeParse(pullRow(itemId)?.writerDetail);
      return parsed.success ? parsed.data : null;
    },

    saveWriterDetail(itemId, detail) {
      if (!pullRow(itemId)) return;
      db.update(githubDetails).set({ writerDetail: detail }).where(eq(githubDetails.itemId, itemId)).run();
    },

    staleWriterDetails(itemIds) {
      const stale: StaleWriterDetail[] = [];
      for (const ids of chunks(itemIds)) {
        const rows = db
          .select({
            itemId: items.id,
            account: items.account,
            data: githubDetails.data,
            writerDetail: githubDetails.writerDetail,
          })
          .from(items)
          .innerJoin(githubDetails, eq(githubDetails.itemId, items.id))
          .where(and(inArray(items.id, ids), eq(items.kind, 'pull-request'), isNull(items.deletedAt)))
          .all();
        for (const row of rows) {
          if (row.data.kind !== 'pull-request' || !row.account) continue;
          const kept = githubWriterDetail.safeParse(row.writerDetail);
          if (kept.success && kept.data.forUpdatedAt === row.data.updatedAt) continue;
          stale.push({
            itemId: row.itemId,
            account: row.account,
            nodeId: row.data.nodeId,
            updatedAt: row.data.updatedAt,
          });
        }
      }
      return stale;
    },

    pullRequests: (itemIds) => liveOfKinds(['pull-request'], itemIds),

    linearIssuesNamed(identifiers) {
      const found = new Map<string, string>();
      const wanted = [...new Set(identifiers.map((each) => each.toUpperCase()))];
      const { linearIssueDetails } = schema;
      for (const names of chunks(wanted)) {
        const rows = db
          .select({ itemId: items.id, identifier: linearIssueDetails.identifier })
          .from(linearIssueDetails)
          .innerJoin(items, eq(items.id, linearIssueDetails.itemId))
          .where(and(inArray(sql`upper(${linearIssueDetails.identifier})`, names), isNull(items.deletedAt)))
          .all();
        for (const row of rows) found.set(row.identifier.toUpperCase(), row.itemId);
      }
      return found;
    },

    githubIssues(refs) {
      const names = [...new Set(refs.map((ref) => `${ref.owner}/${ref.name}#${ref.number}`.toLowerCase()))];
      return chunks(names).flatMap((wanted) =>
        withDetails(
          db
            .select(getTableColumns(items))
            .from(items)
            .innerJoin(githubDetails, eq(githubDetails.itemId, items.id))
            .where(
              and(
                eq(items.kind, 'github-issue'),
                isNull(items.deletedAt),
                inArray(sql`lower(${githubDetails.identifier})`, wanted),
              ),
            )
            .all(),
        ),
      );
    },

    finishesEverMade(fromItemId, toItemId) {
      const { activity } = schema;
      return !!db
        .select({ id: activity.id })
        .from(activity)
        .where(
          and(
            eq(activity.itemId, fromItemId),
            eq(activity.otherItemId, toItemId),
            eq(activity.action, 'link'),
            sql`json_extract(${activity.after}, '$.linkType') = 'finishes'`,
          ),
        )
        .get();
    },
  };
}
