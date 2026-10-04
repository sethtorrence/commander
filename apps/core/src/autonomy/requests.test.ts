import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { type Gate, openGate } from './gate';
import { answerAutonomyRequest } from './requests';

let dir: string;
let store: ItemStore;
let gate: Gate;
let block: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-gate-requests-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
  });
  gate = openGate({ itemStore: store });
  block = store.record(
    {
      type: 'create',
      item: {
        kind: 'block',
        title: 'call the plumber',
        detail: {
          kind: 'block',
          dailyNoteId: store.ensureDailyNote('2026-10-01', { by: { kind: 'user' } }).id,
          parentId: null,
          position: 'a0',
          text: 'call the plumber',
          folded: false,
        },
      },
    },
    { by: { kind: 'user' } },
  ).itemId;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const fromWindow = (request: unknown, id = 1) => ({ type: 'autonomy-request', id, request });
const fromTests = (request: unknown, id = 1) => ({ type: 'autonomy-test-request', id, request });

const register = fromTests({
  op: 'register-action',
  action: { action: 'suggest-todos', actionKind: 'organise', name: 'Suggest Todos' },
});
const propose = (confidence: number) =>
  fromTests({
    op: 'propose',
    proposal: {
      actionKind: 'organise',
      action: 'suggest-todos',
      section: 'notes',
      itemId: block,
      itemActions: [{ type: 'create', item: { kind: 'todo', title: 'Call the plumber' } }],
      confidence,
      reason: 'You wrote that you need to call the plumber',
    },
  });

describe('requests from the window', () => {
  it('reads and changes the Autonomy settings', () => {
    expect(answerAutonomyRequest(gate, fromWindow({ op: 'settings' }), { testHooks: false })).toMatchObject({
      type: 'autonomy-reply',
      id: 1,
      response: { ok: true, result: { settings: { everywhere: { delete: 'off' } }, actions: [] } },
    });
    const changed = answerAutonomyRequest(
      gate,
      fromWindow({ op: 'set-level', target: { scope: 'everywhere', actionKind: 'delete' }, level: 'ask' }, 2),
      { testHooks: false },
    );
    expect(changed).toMatchObject({
      id: 2,
      response: { ok: true, result: { settings: { everywhere: { delete: 'ask' } } } },
    });
  });

  it('answers a refused change with the reason', () => {
    const reply = answerAutonomyRequest(
      gate,
      fromWindow({ op: 'set-level', target: { scope: 'everywhere', actionKind: 'delete' }, level: 'auto' }),
      { testHooks: false },
    );
    expect(reply?.response).toEqual({ ok: false, error: 'Delete can’t go above Ask' });
  });

  it('can never propose', () => {
    const reply = answerAutonomyRequest(gate, fromWindow(propose(1).request), { testHooks: true });
    expect(reply?.response).toMatchObject({ ok: false, error: expect.stringMatching(/Malformed/) });
  });

  it('ignores messages that are not autonomy requests', () => {
    expect(
      answerAutonomyRequest(gate, { type: 'item-store-request', id: 1 }, { testHooks: false }),
    ).toBeNull();
  });
});

describe('Ares’s jobs, from the window', () => {
  // Stands in for the job runner: its interface is tested in ../agent.
  const jobs = {
    enabled: true,
    ran: [] as string[],
    jobs() {
      return [
        {
          job: 'suggest-todos',
          name: 'Suggest Todos',
          tier: 'quick' as const,
          enabled: this.enabled,
          lastRunAt: null,
          lastOutcome: null,
          lastProblem: null,
        },
      ];
    },
    setEnabled(_job: string, enabled: boolean) {
      this.enabled = enabled;
      return this.jobs();
    },
    run(job: string, itemIds?: string[]) {
      this.ran.push(itemIds ? `${job} ${itemIds.join(',')}` : job);
    },
    status: () => ({ working: false, running: [] }),
  };

  it('lists them with whether Ares is working, switches one off and runs one', () => {
    const ask = (request: unknown) =>
      answerAutonomyRequest(gate, fromWindow(request), { testHooks: false, jobs })?.response;
    expect(ask({ op: 'jobs' })).toEqual({
      ok: true,
      result: {
        jobs: [expect.objectContaining({ job: 'suggest-todos', enabled: true })],
        status: { working: false, running: [] },
      },
    });
    expect(ask({ op: 'set-job-enabled', job: 'suggest-todos', enabled: false })).toMatchObject({
      ok: true,
      result: { jobs: [{ enabled: false }] },
    });
    expect(ask({ op: 'run-job', job: 'suggest-todos' })).toMatchObject({ ok: true });
    // On given Items (Prepare now on one meeting).
    expect(ask({ op: 'run-job', job: 'prepare-meetings', itemIds: ['event-1'] })).toMatchObject({ ok: true });
    expect(jobs.ran).toEqual(['suggest-todos', 'prepare-meetings event-1']);
  });

  it('says so when the Core has no job runner', () => {
    expect(answerAutonomyRequest(gate, fromWindow({ op: 'jobs' }), { testHooks: false })?.response).toEqual({
      ok: false,
      error: 'Ares’s jobs aren’t running',
    });
  });
});

describe('requests from end-to-end tests', () => {
  it('are refused unless the Core was started with test hooks', () => {
    expect(answerAutonomyRequest(gate, register, { testHooks: false })?.response).toEqual({
      ok: false,
      error: 'Test hooks are off',
    });
  });

  it('register actions and hand proposals to the gate', () => {
    expect(answerAutonomyRequest(gate, register, { testHooks: true })).toEqual({
      type: 'autonomy-test-reply',
      id: 1,
      response: { ok: true, result: null },
    });
    expect(answerAutonomyRequest(gate, propose(0.3), { testHooks: true })?.response).toMatchObject({
      ok: true,
      result: { decision: 'ask', suggestion: { status: 'pending' } },
    });
    const [suggestion] = gate.activity();
    expect(
      answerAutonomyRequest(gate, fromWindow({ op: 'accept', proposalId: suggestion?.id }), {
        testHooks: false,
      })?.response,
    ).toMatchObject({ ok: true, result: { status: 'accepted' } });
  });
});
