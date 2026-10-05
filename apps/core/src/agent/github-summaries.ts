// When Ares writes the GitHub summary (#121), and asking him to: the schedule around the "Write the
// GitHub summary" job (write-github-summary.ts).
//
// - Daily: everything since the last daily summary, once the machine is first active each day after
//   05:00 (the presence signal, and Commander starting), or at the first GitHub sync after that, so it
//   is ready by the time the User opens the window. One a day: each is kept with its day, so a restart
//   never writes another. On Mondays, the roll-up of the previous Monday to Sunday too.
// - On demand (Ask Ares to write it, and later a Conversation): the range and scope asked for. The
//   answer is the summary he wrote, or why there is none (the plain summary shows then).
// - Before either, the writer's detail of the pull requests in range is fetched where it is missing
//   or out of date (the oversight summary's GraphQL batches), so Ares reads the work as it is now.
import {
  dueSummaries,
  factsEmpty,
  type GitHubSummaryAnswer,
  oversightLocalTime,
  type PersonParagraphAnswer,
  type PersonParagraphRequest,
  type SummaryRequest,
  WRITE_GITHUB_SUMMARY,
  writerProblem,
} from '@commander/domain';
import type { ItemStore } from '../item-store';
import { summaryWriter } from '../item-store-requests';
import type { JobRunner } from './runner';
import type { SummaryWant, WriteGitHubSummaryJob } from './write-github-summary';

export type GitHubSummariesOptions = {
  itemStore: ItemStore;
  runner: Pick<JobRunner, 'trigger' | 'run' | 'settled'>;
  job: Pick<WriteGitHubSummaryJob, 'want' | 'ask' | 'settle' | 'askPerson' | 'settlePerson'>;
  // Fetches the writer's detail of these pull requests where it is missing or out of date.
  prepareWriterDetails?: (itemIds: readonly string[]) => Promise<void>;
  now?: () => number;
  timeZone?: string;
  // The hour the daily summary is due from (05:00; the end-to-end tests start it at midnight).
  hour?: number;
  // Whether the Monday roll-up is written too (true unless a test turns it off).
  rollUp?: boolean;
  log?: (message: string) => void;
};

export type GitHubSummaries = {
  // Writes what is due now (the User became active, Commander started, GitHub synced).
  due(): Promise<void>;
  // Ask Ares to write it: the summary he wrote, or why there is none.
  ask(request: SummaryRequest): Promise<GitHubSummaryAnswer>;
  // Refresh on a People card (#122): one Person's paragraph written again, or why there is none.
  refreshPerson(request: PersonParagraphRequest): Promise<PersonParagraphAnswer>;
};

export function createGitHubSummaries({
  itemStore,
  runner,
  job,
  prepareWriterDetails,
  now = Date.now,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  hour,
  rollUp = true,
  log = (message) => console.warn(message),
}: GitHubSummariesOptions): GitHubSummaries {
  let asking = 0;
  let checking: Promise<void> | null = null;

  // The Items in a range's facts; null when nothing happened there (a fire has no Items, but counts).
  function itemsIn(range: SummaryWant['range'], projectId?: string | null): string[] | null {
    const facts = itemStore.githubOversight.summary({ range, ...(projectId !== undefined && { projectId }) });
    if (factsEmpty(facts)) return null;
    const ids = facts.sections.flatMap((section) =>
      section.groups.flatMap((group) => group.entries.flatMap((entry) => entry.itemIds)),
    );
    return [...new Set(ids)];
  }

  // The pull requests' detail fetched before Ares reads them.
  async function prepare(itemIds: string[]) {
    if (!prepareWriterDetails || !itemIds.length) return;
    try {
      await prepareWriterDetails(itemIds);
    } catch (error) {
      log(`Couldn’t fetch the pull requests’ detail for the GitHub summary: ${String(error)}`);
    }
  }

  async function check() {
    const due: SummaryWant[] = dueSummaries({
      now: now(),
      timeZone,
      lastDailyTo: itemStore.githubSummaries.lastDailyTo(),
      written: (cadence, day) => itemStore.githubSummaries.writtenFor(cadence, day),
      ...(hour !== undefined && { hour }),
    })
      .filter((each) => rollUp || each.cadence !== 'weekly')
      .map((each) => ({ ...each, key: `${each.cadence}:${each.day}`, choice: null }));
    // A quiet range has nothing to write about: it is looked at again on the next check.
    const wants = due.flatMap((want) => {
      const itemIds = itemsIn(want.range);
      return itemIds ? [{ want, itemIds }] : [];
    });
    job.want(wants.map(({ want }) => want));
    if (!wants.length) return;
    for (const { itemIds } of wants) await prepare(itemIds);
    runner.trigger({ kind: 'due', job: WRITE_GITHUB_SUMMARY });
  }

  return {
    due() {
      // Checks close together (a sync as the User comes back) look once.
      checking ??= check().finally(() => {
        checking = null;
      });
      return checking;
    },

    async ask(request) {
      const at = now();
      asking += 1;
      const want: SummaryWant = {
        key: `ask:${at}:${asking}`,
        cadence: 'on-demand',
        day: oversightLocalTime(at, timeZone).day,
        range: request.range,
        ...(request.projectId !== undefined && { projectId: request.projectId }),
        choice: request.choice,
      };
      await prepare(itemsIn(want.range, want.projectId) ?? []);
      job.ask(want);
      runner.run(WRITE_GITHUB_SUMMARY);
      await runner.settled();
      const outcome = job.settle(want.key);
      const summary = outcome.itemId ? (itemStore.get(outcome.itemId)?.item ?? null) : null;
      if (summary) return { summary, problem: null };
      return {
        summary: null,
        problem:
          outcome.problem ??
          writerProblem(summaryWriter(itemStore)) ??
          'Ares couldn’t write the summary just now.',
      };
    },

    async refreshPerson({ personId, range }) {
      asking += 1;
      const key = `refresh:${now()}:${asking}`;
      // Their pull requests' detail first, as for a summary.
      const [week] = itemStore.githubOversight.people({ range, personId });
      const pulls = week
        ? [...week.merged, ...week.reviewed, ...week.opened, ...week.open, ...week.waiting]
        : [];
      await prepare([...new Set(pulls.map((pull) => pull.itemId))]);
      job.askPerson({ key, personId, range });
      runner.run(WRITE_GITHUB_SUMMARY);
      await runner.settled();
      const outcome = job.settlePerson(key);
      if (outcome.paragraph) return { paragraph: outcome.paragraph, problem: null };
      return {
        paragraph: null,
        problem:
          outcome.problem ?? writerProblem(summaryWriter(itemStore)) ?? 'Ares couldn’t write it just now.',
      };
    },
  };
}
