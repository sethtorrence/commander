// The oversight summary in the Core (#119). After each GitHub sync:
//
// - Finishes Links: a pull request whose title, branch name or body names a Linear issue Commander
//   holds (domain linearIdentifiersIn), or whose closing issue names one or is linked to one, gets a
//   finishes Link to it, made by the Source (GitHub) with why it was made. A Linear sync that brings
//   issues looks again over every pull request. A Link once made is never made again: one the User
//   removed stays removed. These come from the Source's own data, not from a model, so they don't go
//   through the gate (ADR 0004 concerns what Ares proposes).
// - The writer's detail (#121's input): for the Account's pull requests in today's summary (since
//   yesterday, in this machine's time zone), what is missing or older than the pull request is
//   fetched in GraphQL batches (readGitHubWriterDetails) and kept beside its detail. The Account's
//   token is borrowed per fetch and never kept. `prepareWriterDetails` does the same for any pull
//   requests, for the writer's own ranges.
//
// The summary itself is read through the Item store (item-store-requests.ts, `github-oversight`).
import {
  closingIssueRefs,
  githubIdentifier,
  type IssueRef,
  type Item,
  type LinkEnd,
  linearIdentifiersIn,
  oversightRange,
  type PullRequestDetail,
} from '@commander/domain';
import { readGitHubWriterDetails, SignInRefused } from '@commander/sources';
import type { AccessTokens } from '../access-tokens';
import type { ItemStore } from '../item-store';
import type { SyncedEvent } from '../sync';

export type GitHubOversightOptions = {
  accessTokens: Pick<AccessTokens, 'request'>;
  // Where GitHub's REST API lives (GraphQL is <apiUrl>/graphql), as sync last heard it.
  apiUrl: () => string;
  // How the Core asks GitHub (stood in for in tests).
  read?: typeof readGitHubWriterDetails;
  // The time zone "since yesterday" is reckoned in; this machine's unless given.
  timeZone?: string;
  now?: () => number;
  log?: (message: string) => void;
  // GitHub refused an Account's sign-in while fetching: the main process checks it.
  onSignInRefused?: (account: string) => void;
};

type Target = { linearId: string; why: string };

const isLinear = (end: LinkEnd) =>
  end.kind === 'linear-issue' && 'deletedAt' in end && end.deletedAt === null;

export function setUpGitHubOversight(
  store: ItemStore,
  {
    accessTokens,
    apiUrl,
    read = readGitHubWriterDetails,
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    now = Date.now,
    log = (message) => console.warn(message),
    onSignInRefused,
  }: GitHubOversightOptions,
) {
  const oversight = store.githubOversight;

  // Every Linear issue a pull request finishes, with why: named by the pull request itself, then
  // through its closing issues. Identifiers not held by Commander are dropped by the caller.
  function namedBy(pull: Item & { detail: PullRequestDetail }) {
    const { detail } = pull;
    const name = githubIdentifier(detail.repo, detail.number);
    const own = new Set([
      ...linearIdentifiersIn(pull.title),
      ...linearIdentifiersIn(detail.headBranch),
      ...linearIdentifiersIn(detail.body),
    ]);
    const refs: IssueRef[] = [
      ...detail.closingIssues.map(({ owner, name: repo, number }) => ({ owner, name: repo, number })),
      ...closingIssueRefs(detail.body, detail.repo),
    ];
    return { name, own: [...own], closing: refs.length ? oversight.githubIssues(refs) : [] };
  }

  /** Makes the finishes Links these pull requests (or all) call for. Returns the Items they touch. */
  function linkFinishes(pullRequestIds?: readonly string[]): string[] {
    const pulls = oversight
      .pullRequests(pullRequestIds)
      .filter((item): item is Item & { detail: PullRequestDetail } => item.detail?.kind === 'pull-request');
    const found = pulls.map((pull) => ({ pull, ...namedBy(pull) }));
    const identifiers = found.flatMap((each) => [
      ...each.own,
      ...each.closing.flatMap((issue) => [
        ...linearIdentifiersIn(issue.title),
        ...linearIdentifiersIn(issue.detail?.kind === 'github-issue' ? issue.detail.body : ''),
      ]),
    ]);
    const linear = identifiers.length ? oversight.linearIssuesNamed(identifiers) : new Map<string, string>();
    const touched = new Set<string>();

    for (const { pull, name, own, closing } of found) {
      const targets = new Map<string, Target>();
      for (const identifier of own) {
        const linearId = linear.get(identifier);
        if (linearId && !targets.has(linearId))
          targets.set(linearId, { linearId, why: `${name} names ${identifier}` });
      }
      for (const issue of closing) {
        if (issue.detail?.kind !== 'github-issue') continue;
        const issueName = githubIdentifier(issue.detail.repo, issue.detail.number);
        const via = `${name} closes ${issueName}`;
        for (const identifier of [
          ...linearIdentifiersIn(issue.title),
          ...linearIdentifiersIn(issue.detail.body),
        ]) {
          const linearId = linear.get(identifier);
          if (linearId && !targets.has(linearId))
            targets.set(linearId, { linearId, why: `${via}, which names ${identifier}` });
        }
        const view = store.get(issue.id);
        const ends = [
          ...(view?.links.map((link) => link.to) ?? []),
          ...(view?.backlinks.map((link) => link.from) ?? []),
        ];
        for (const end of ends)
          if (isLinear(end) && !targets.has(end.id))
            targets.set(end.id, { linearId: end.id, why: `${via}, which is linked to ${end.title}` });
      }
      if (!targets.size || !pull.account) continue;
      const present = new Set(
        store
          .get(pull.id)
          ?.links.filter((link) => link.type === 'finishes')
          .map((link) => link.to.id),
      );
      for (const { linearId, why } of targets.values()) {
        if (present.has(linearId) || oversight.finishesEverMade(pull.id, linearId)) continue;
        store.link(
          { from: pull.id, linkType: 'finishes', to: linearId },
          { by: { kind: 'source', source: 'github', account: pull.account }, why },
        );
        touched.add(pull.id);
        touched.add(linearId);
      }
    }
    return [...touched];
  }

  // Fetches under way, by Account, so syncs close together ask GitHub once.
  const fetching = new Map<string, Promise<void>>();

  /** Fetches the writer's detail for these pull requests where it is missing or out of date. */
  async function prepareWriterDetails(itemIds: readonly string[]): Promise<void> {
    const stale = oversight.staleWriterDetails(itemIds);
    const byAccount = new Map<string, typeof stale>();
    for (const each of stale) byAccount.set(each.account, [...(byAccount.get(each.account) ?? []), each]);
    for (const [account, pulls] of byAccount) {
      let token: Awaited<ReturnType<AccessTokens['request']>>;
      try {
        token = await accessTokens.request(account);
      } catch (error) {
        log(`Couldn't borrow ${account}'s token for the oversight summary: ${String(error)}`);
        continue;
      }
      try {
        const found = await read(
          { apiUrl: apiUrl(), token },
          pulls.map((pull) => pull.nodeId),
        );
        for (const pull of pulls) {
          const detail = found.get(pull.nodeId);
          if (detail)
            oversight.saveWriterDetail(pull.itemId, {
              ...detail,
              forUpdatedAt: pull.updatedAt,
              fetchedAt: now(),
            });
        }
      } catch (error) {
        if (error instanceof SignInRefused) onSignInRefused?.(account);
        log(`Couldn't fetch the oversight summary's pull request detail: ${String(error)}`);
      }
    }
  }

  // The Account's pull requests in today's summary.
  function inTodaysSummary(account: string): string[] {
    const summary = oversight.summary({
      range: oversightRange({ kind: 'since-yesterday' }, now(), timeZone),
    });
    const ids = new Set(
      summary.sections.flatMap((section) =>
        section.groups.flatMap((group) => group.entries.flatMap((entry) => entry.itemIds)),
      ),
    );
    return oversight
      .pullRequests([...ids])
      .filter((pull) => pull.account === account)
      .map((pull) => pull.id);
  }

  return {
    linkFinishes,
    prepareWriterDetails,

    /** After a sync: finishes Links, and (for GitHub) the writer's detail. Returns the Items changed. */
    async synced(event: SyncedEvent): Promise<string[]> {
      if (event.outcome !== 'synced') return [];
      if (event.source === 'linear') return event.itemIds.length ? linkFinishes() : [];
      if (event.source !== 'github') return [];
      const changed = linkFinishes(event.itemIds);
      let under = fetching.get(event.account);
      if (!under) {
        under = prepareWriterDetails(inTodaysSummary(event.account)).finally(() =>
          fetching.delete(event.account),
        );
        fetching.set(event.account, under);
      }
      await under;
      return changed;
    },
  };
}
