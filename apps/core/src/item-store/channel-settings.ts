// Excluding Teams teams and channels from Channel posts (#111), kept in the Item store's database so
// the Item store stays its only writer. Every channel of every team syncs unless the User excludes
// it, alone or with its team. Excluding deletes the posts Commander holds from there, as the User (a
// tombstone each, so notes and Todos keep their Links, shown as gone), and the sync engine tells the
// Teams adapter to skip it until it is included again, when the next sync brings its posts back.
import {
  type ActionContext,
  type ActivityEntry,
  type ChannelChoices,
  type ChannelSetting,
  type ChannelSettingAction,
  channelSettingAction,
  type TeamsCatalog,
  teamsCatalog,
} from '@commander/domain';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type ChannelSettingsStore = {
  // The teams and channels excluded, by Account; one Account's when given.
  list(account?: string): ChannelSetting[];
  // An Account's exclusions, for its sync to skip (`channelId` null: the whole team).
  excluded(account: string): { teamId: string; channelId: string | null }[];
  // Each Teams Account's teams and channels as its last sync listed them, each with whether it is
  // excluded (and any excluded one no longer listed, so it can be included again).
  choices(): ChannelChoices[];
  // Excludes a team or channel (deleting its posts) or includes it again. Returns the Account's choices.
  change(action: ChannelSettingAction, context: ActionContext): ChannelChoices;
  // When the Account is removed.
  removeAccount(account: string): void;
};

const WHOLE_TEAM = '';

export function channelSettingsIn(
  db: BetterSQLite3Database<typeof schema>,
  {
    now,
    deleteItem,
  }: {
    now: () => number;
    // Deletes an Item, recording it with the context given.
    deleteItem: (itemId: string, context: ActionContext) => ActivityEntry;
  },
): ChannelSettingsStore {
  const table = schema.channelSettings;
  const toSetting = (row: typeof table.$inferSelect): ChannelSetting => ({
    account: row.account,
    teamId: row.teamId,
    channelId: row.channelId === WHOLE_TEAM ? null : row.channelId,
    name: row.name,
    excludedAt: row.excludedAt,
  });

  function list(account?: string): ChannelSetting[] {
    return db
      .select()
      .from(table)
      .where(account ? eq(table.account, account) : undefined)
      .orderBy(asc(table.account), asc(table.excludedAt), asc(table.teamId), asc(table.channelId))
      .all()
      .map(toSetting);
  }

  function catalogs(account?: string): { account: string; catalog: TeamsCatalog; fetchedAt: number }[] {
    const { sourceCatalogs } = schema;
    return db
      .select()
      .from(sourceCatalogs)
      .where(
        and(eq(sourceCatalogs.source, 'teams'), account ? eq(sourceCatalogs.account, account) : undefined),
      )
      .orderBy(asc(sourceCatalogs.account))
      .all()
      .flatMap((row) => {
        const parsed = teamsCatalog.safeParse(row.catalog);
        return parsed.success
          ? [{ account: row.account, catalog: parsed.data, fetchedAt: row.fetchedAt }]
          : [];
      });
  }

  function choicesOf(account: string): ChannelChoices {
    const listed = catalogs(account)[0] ?? null;
    const settings = list(account);
    const teamOut = (teamId: string) =>
      settings.some((each) => each.teamId === teamId && each.channelId === null);
    const channelOut = (teamId: string, channelId: string) =>
      settings.some((each) => each.teamId === teamId && each.channelId === channelId);
    const teams: ChannelChoices['teams'] = (listed?.catalog.teams ?? []).map((team) => ({
      id: team.id,
      name: team.name,
      excluded: teamOut(team.id),
      channels: team.channels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        excluded: teamOut(team.id) || channelOut(team.id, channel.id),
      })),
    }));
    // Excluded ones the last listing no longer has, so they can be included again.
    for (const setting of settings) {
      let team = teams.find((each) => each.id === setting.teamId);
      if (!team) {
        team = {
          id: setting.teamId,
          name: setting.channelId === null ? setting.name : 'Team',
          excluded: false,
          channels: [],
        };
        teams.push(team);
      }
      if (setting.channelId === null) team.excluded = true;
      else if (!team.channels.some((channel) => channel.id === setting.channelId))
        team.channels.push({ id: setting.channelId, name: setting.name, excluded: true });
    }
    return { account, listedAt: listed?.fetchedAt ?? null, teams };
  }

  // The live posts Commander holds from a team (or one of its channels).
  function postsIn(account: string, teamId: string, channelId: string | null): string[] {
    const { items, channelPostDetails } = schema;
    return db
      .select({ id: items.id })
      .from(channelPostDetails)
      .innerJoin(items, eq(items.id, channelPostDetails.itemId))
      .where(
        and(
          eq(items.account, account),
          eq(items.kind, 'channel-post'),
          isNull(items.deletedAt),
          eq(channelPostDetails.teamId, teamId),
          channelId === null ? undefined : eq(channelPostDetails.channelId, channelId),
        ),
      )
      .all()
      .map((row) => row.id);
  }

  return {
    list,

    excluded(account) {
      return list(account).map(({ teamId, channelId }) => ({ teamId, channelId }));
    },

    choices() {
      const accounts = new Set([
        ...catalogs().map((each) => each.account),
        ...list().map((each) => each.account),
      ]);
      return [...accounts].sort().map(choicesOf);
    },

    change(raw, context) {
      const { account, teamId, channelId, change } = channelSettingAction.parse(raw);
      const key = and(
        eq(table.account, account),
        eq(table.teamId, teamId),
        eq(table.channelId, channelId ?? WHOLE_TEAM),
      );
      if (change === 'include') {
        db.delete(table).where(key).run();
        return choicesOf(account);
      }
      const team = choicesOf(account).teams.find((each) => each.id === teamId);
      const channel = channelId === null ? null : team?.channels.find((each) => each.id === channelId);
      const name =
        channelId === null
          ? (team?.name ?? 'Team')
          : `${team?.name ?? 'Team'} / ${channel?.name ?? 'Channel'}`;
      db.insert(table)
        .values({ account, teamId, channelId: channelId ?? WHOLE_TEAM, name, excludedAt: now() })
        .onConflictDoNothing()
        .run();
      const why =
        channelId === null ? 'Excluded the team from Commander' : 'Excluded the channel from Commander';
      for (const itemId of postsIn(account, teamId, channelId))
        deleteItem(itemId, { ...context, why: context.why ?? why });
      return choicesOf(account);
    },

    removeAccount(account) {
      db.delete(table).where(eq(table.account, account)).run();
    },
  };
}
