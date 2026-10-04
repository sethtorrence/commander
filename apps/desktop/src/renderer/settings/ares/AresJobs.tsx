import type { AgentJobInfo, AgentJobsState, JobOutcome } from '@commander/domain';
import { Button, Switch, toast } from '@commander/ui';
import { useCallback, useEffect, useState } from 'react';
import { clockTime } from '../../frame/calendar';
import { SettingRow } from '../parts';

export type JobsClient = (
  request:
    | { op: 'jobs' }
    | { op: 'set-job-enabled'; job: string; enabled: boolean }
    | { op: 'run-job'; job: string },
) => Promise<AgentJobsState>;

const TIER_NAMES = { quick: 'Quick', deep: 'Deep' } as const;

const OUTCOMES: Record<JobOutcome, string> = {
  ok: 'done',
  'nothing-to-do': 'nothing new',
  'over-cap': 'skipped at the monthly cap',
  'invalid-reply': 'the reply didn’t fit, so it was discarded',
  failed: 'failed',
};

function lastRun(job: AgentJobInfo): string {
  if (job.lastRunAt === null || !job.lastOutcome) return 'Not run yet';
  const when = new Date(job.lastRunAt);
  const at = `${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${clockTime(when).slice(0, 5)}`;
  return `Last ran ${at}: ${OUTCOMES[job.lastOutcome]}${job.lastProblem ? `. ${job.lastProblem}` : ''}`;
}

/**
 * Settings → Ares → Jobs: each of Ares's jobs with its tier and how its last run went, a switch to
 * turn it off (off, it never runs), and Run now.
 */
export function AresJobs({ client = window.commander.autonomy }: { client?: JobsClient }) {
  const [jobs, setJobs] = useState<AgentJobInfo[] | null>(null);

  const ask = useCallback(
    (request: Parameters<JobsClient>[0]) =>
      client(request).then(
        (state) => setJobs(state.jobs),
        (error: unknown) => toast(error instanceof Error ? error.message : String(error)),
      ),
    [client],
  );

  useEffect(() => {
    void ask({ op: 'jobs' });
  }, [ask]);

  return (
    <SettingRow
      label="Jobs"
      description="What Ares does on his own, each on its own trigger. A job switched off never runs. Every call is on the Usage page."
    >
      <ul className="m-0 grid max-w-[560px] list-none gap-0 border-t border-line p-0" data-testid="ares-jobs">
        {/* Holds the row's height until the Core answers, so nothing below jumps. */}
        {!jobs && (
          <li className="flex min-h-[64px] items-center border-b border-line2 py-2.5 text-note text-muted">
            Asking the Core…
          </li>
        )}
        {jobs?.map((job) => (
          <li key={job.job} className="flex min-h-[64px] items-center gap-4 border-b border-line2 py-2.5">
            <Switch
              aria-label={job.name}
              checked={job.enabled}
              onCheckedChange={(enabled) => void ask({ op: 'set-job-enabled', job: job.job, enabled })}
            />
            <div className="min-w-0 flex-1">
              <div className="text-row leading-[22px] font-semibold text-ink">
                {job.name}
                <span className="ml-2 font-mono text-label font-semibold uppercase tracking-label text-muted">
                  {TIER_NAMES[job.tier]}
                </span>
              </div>
              <div data-testid="job-last-run" className="text-note leading-[19px] text-muted">
                {lastRun(job)}
              </div>
            </div>
            <Button
              size="sm"
              aria-label={`Run ${job.name} now`}
              disabled={!job.enabled}
              onClick={() =>
                void ask({ op: 'run-job', job: job.job }).then(() =>
                  setTimeout(() => void ask({ op: 'jobs' }), 1500),
                )
              }
            >
              Run now
            </Button>
          </li>
        ))}
      </ul>
    </SettingRow>
  );
}
