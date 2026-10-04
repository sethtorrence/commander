// @vitest-environment jsdom
import type { AgentJobInfo, AgentJobsState } from '@commander/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AresJobs, type JobsClient } from './AresJobs';

afterEach(cleanup);

// Stands in for the Core: one job, which the switch and Run now change.
function fakeCore() {
  const requests: unknown[] = [];
  let job: AgentJobInfo = {
    job: 'suggest-todos',
    name: 'Suggest Todos',
    tier: 'quick',
    enabled: true,
    lastRunAt: null,
    lastOutcome: null,
    lastProblem: null,
  };
  const state = (): AgentJobsState => ({ jobs: [job], status: { working: false, running: [] } });
  const client: JobsClient = async (request) => {
    requests.push(request);
    if (request.op === 'set-job-enabled') job = { ...job, enabled: request.enabled };
    if (request.op === 'run-job')
      job = { ...job, lastRunAt: 1, lastOutcome: 'over-cap', lastProblem: 'At the cap.' };
    return state();
  };
  return { client, requests };
}

describe('Settings → Ares: his jobs', () => {
  it('lists each job with a switch, and switching one off tells the Core', async () => {
    const core = fakeCore();
    render(<AresJobs client={core.client} />);
    const toggle = await screen.findByRole('switch', { name: 'Suggest Todos' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('ares-jobs').textContent).toContain('Quick');

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(core.requests).toContainEqual({ op: 'set-job-enabled', job: 'suggest-todos', enabled: false });
  });

  it('runs a job now, and says how its last run went', async () => {
    const core = fakeCore();
    render(<AresJobs client={core.client} />);
    expect((await screen.findByTestId('job-last-run')).textContent).toBe('Not run yet');
    fireEvent.click(screen.getByRole('button', { name: 'Run Suggest Todos now' }));
    await waitFor(() => expect(screen.getByTestId('job-last-run').textContent).toContain('At the cap.'));
  });
});
