import { ModelError } from '@commander/models';
import { describe, expect, it } from 'vitest';
import { modelErrorLine } from '../models';
import { migrationsText, recoveryLine, syncRunLine } from './lines';

// What the Core's log lines say (#207): ids, counts, times and plain reasons.

const run = {
  account: 'google:1',
  source: 'gmail' as const,
  trigger: 'scheduled' as const,
  startedAt: 1_000,
  finishedAt: 2_400,
  outcome: 'synced' as const,
  created: 3,
  updated: 2,
  tombstoned: 0,
  unchanged: 40,
  requests: 5,
  complexity: null,
  error: null,
};

describe('syncRunLine', () => {
  it('says what a sync did, and why one didn’t finish', () => {
    expect(syncRunLine(run)).toBe(
      'gmail sync of google:1 (scheduled): synced in 1.4 s · 3 new, 2 updated, 0 removed, 40 unchanged · 5 requests',
    );
    expect(
      syncRunLine({
        ...run,
        trigger: 'refresh',
        outcome: 'failed',
        requests: 1,
        error: 'Gmail didn’t answer',
      }),
    ).toBe(
      'gmail sync of google:1 (refresh): failed after 1.4 s · 3 new, 2 updated, 0 removed, 40 unchanged · 1 request · Gmail didn’t answer',
    );
  });
});

describe('migrationsText', () => {
  it('names a few migrations, and shortens a long run', () => {
    expect(migrationsText(['0054_setting_changes', '0055_conversation_made'])).toBe(
      '0054_setting_changes, 0055_conversation_made',
    );
    expect(migrationsText(['0000_a', '0001_b', '0002_c', '0003_d', '0004_e'])).toBe(
      '5 migrations, 0000_a to 0004_e',
    );
  });
});

describe('recoveryLine', () => {
  it('says why the Core stayed in its limited state', () => {
    expect(
      recoveryLine({ state: 'damaged', problem: 'page 4 is broken', snapshot: null, restoreFailed: null }),
    ).toBe(
      'The database is damaged (page 4 is broken); the recovery screen offers no snapshot that passes the check',
    );
    expect(
      recoveryLine({
        state: 'update-failed',
        migration: '0056_x',
        reason: 'no such table',
        snapshot: {
          name: 'commander-before-update-2026-10-06-091502.db',
          kind: 'before-update',
          day: '2026-10-06',
          time: '09:15',
          size: 1,
        },
        snapshotProblem: null,
        restoreFailed: null,
      }),
    ).toBe(
      'The migration 0056_x failed (no such table); the database is as the previous version left it, and the recovery screen offers the snapshot commander-before-update-2026-10-06-091502.db',
    );
  });
});

describe('modelErrorLine', () => {
  it('names the model and why, never the prompt', () => {
    const setting = { model: 'glm-5.3-flash', baseUrl: 'https://api.z.ai/api/paas/v4' };
    expect(modelErrorLine({ setting }, new ModelError('rate-limit', 'Slow down.', { status: 429 }))).toBe(
      'Model call to glm-5.3-flash failed (rate-limit, HTTP 429): Slow down.',
    );
    expect(modelErrorLine({ setting }, new Error('socket hang up'))).toBe(
      'Model call to glm-5.3-flash failed (error): socket hang up',
    );
  });
});
