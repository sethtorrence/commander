import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setUpDiagnostics } from '@commander/core/src/diagnostics';
import { type ItemStore, openItemStore } from '@commander/core/src/item-store';
import { syncRunLine } from '@commander/core/src/logs/lines';
import { createLog, LEFT_OUT, logsDir } from '@commander/core/src/logs/log-file';
import { createKnownSecrets } from '@commander/core/src/safety/known-secrets';
import type { CoreStatus, Diagnostics, EmailDetail, LinearIssueDetail, SourceItem } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDiagnosticsChannel, exportFileName } from './diagnostics-channel';

// Export diagnostics (#207): the logs, versions and settings that aren't secret, in a file the User
// picks; never a token, a key, email text or Item content. The Core's side runs on a real Item store
// holding an email and a Todo, and the planted secrets reach the log and a sync run's reason as a
// failing Source's or a careless warning would.

const migrationsFolder = join(import.meta.dirname, '../../../core/drizzle');

// Written in pieces so the source never holds a whole token-shaped string.
const TOKEN = 'gh' + 'p_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const BEARER_TOKEN = 'ya29' + '.a0AfH6SMBx1234567890abcdefghijk';
// A key with no telltale shape, known only because the Core was handed it.
const KNOWN_KEY = 'plain words only the keyring holds';
const EMAIL_BODY = 'Meet me at the boathouse at noon, bring the blueprints';
const EMAIL_SUBJECT = 'Boathouse plans';
const ITEM_TEXT = 'Buy oat milk for the Tactics offsite';
const ISSUE_TITLE = 'Fix the Northwind login loop';

const T = Date.UTC(2026, 9, 6, 0, 0, 30);

const about: Diagnostics = {
  displayServer: 'wayland',
  displaySource: 'compositor',
  passwordStore: 'gnome-libsecret',
  version: '0.1.0',
  electron: '44.5.1',
  chrome: '150.0.0.0',
  node: '24.1.0',
  os: 'linux 7.2.7 (x64)',
};
const core: CoreStatus = {
  state: 'running',
  restartAt: null,
  restarts: 1,
  lastStop: { at: T - 60_000, reason: 'exited', code: 1 },
  database: { state: 'ok' },
};

function email(): SourceItem {
  const detail: EmailDetail = {
    kind: 'email',
    messageId: '<m1@mail.test>',
    inReplyTo: null,
    references: [],
    threadKey: 'mid:<m1@mail.test>',
    sourceThreadId: 'g-m1',
    from: { name: 'Dana Whitfield', address: 'dana@northwind.test' },
    to: [{ name: 'Alex Kim', address: 'alex@gmail.test' }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: EMAIL_SUBJECT,
    sentAt: T,
    snippet: EMAIL_BODY.slice(0, 30),
    read: false,
    starred: false,
    inInbox: true,
    sentByMe: false,
    labels: [{ id: 'INBOX', name: 'Inbox' }],
    attachments: [],
    hasInvitation: false,
    listUnsubscribe: null,
    listId: null,
  };
  return {
    externalId: 'm1',
    kind: 'email',
    title: EMAIL_SUBJECT,
    people: ['dana@northwind.test'],
    status: 'open',
    detail,
    body: { text: EMAIL_BODY, html: null, textFromHtml: false, truncated: false },
  };
}

// A Linear issue whose change to Done couldn't sync (#206), as the sync engine leaves it after a refusal.
function couldntSyncIssue() {
  const state = { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' };
  const detail: LinearIssueDetail = {
    kind: 'linear-issue',
    identifier: 'ENG-418',
    url: 'https://linear.app/acme/issue/ENG-418',
    team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
    state,
    priority: 2,
    assignee: null,
    creator: null,
    labels: [],
    cycle: null,
    linearProject: null,
    dueDate: null,
    estimate: null,
    description: null,
    comments: [],
    createdAt: T - 86_400_000,
    updatedAt: T - 3_600_000,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
  };
  store.saveFromSource({
    source: 'linear',
    account: 'linear:acme',
    items: [{ externalId: 'issue-418', kind: 'linear-issue', title: ISSUE_TITLE, detail }],
  });
  const [issue] = store.query({ kinds: ['linear-issue'] });
  if (!issue) throw new Error('no issue');
  store.record(
    {
      type: 'edit-fields',
      itemId: issue.id,
      fields: { state: { ...state, id: 'state-done', name: 'Done', type: 'completed' } },
    },
    { by: { kind: 'user' } },
  );
  const ids = store.outgoing.rows().map((row) => row.id);
  store.outgoing.fail(ids, { error: 'The issue is locked for editing.', failed: true, nextAttemptAt: null });
}

let dir: string;
let store: ItemStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-diagnostics-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => T,
  });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// The window's channel wired straight to the Core's side, as main and the Core are through messages.
function wire({ coreDown = false, chosen = join(dir, 'export.md') } = {}) {
  const secrets = createKnownSecrets();
  secrets.remember(KNOWN_KEY);
  let reply: (message: unknown) => void = () => {};
  const diagnostics = setUpDiagnostics({
    store,
    migrationsFolder,
    statuses: () => [],
    snapshots: () => ({ snapshots: [], problems: [] }),
    secrets,
    send: (message) => reply(message),
  });
  const offered: string[] = [];
  const channel = createDiagnosticsChannel({
    send: (message) => queueMicrotask(() => diagnostics.handle(message)),
    whileCoreRuns: (run) => (coreDown ? Promise.resolve({ ok: false, error: 'down' }) : run()),
    logsDir: logsDir(dir),
    about: async () => about,
    coreStatus: () => core,
    chooseFile: async (suggested) => {
      offered.push(suggested);
      return chosen;
    },
    now: () => T,
  });
  reply = (message) => channel.settle(message);
  return { channel, secrets, offered, chosen };
}

// What the Core and main have logged, secrets planted as they could arrive.
function plantLogs(secrets: ReturnType<typeof createKnownSecrets>) {
  const coreLog = createLog({ dir: logsDir(dir), process: 'core', secrets, now: () => T, echo: false });
  const mainLog = createLog({ dir: logsDir(dir), process: 'main', now: () => T + 1, echo: false });
  coreLog.info('core', 'The Core started (pid 42)');
  const restore = coreLog.captureConsole();
  try {
    console.warn('Sync engine error for github:1 (github):', new Error(`401 for token ${TOKEN}`));
  } finally {
    restore();
  }
  coreLog.warn('models', `Model call failed: Authorization: Bearer ${BEARER_TOKEN}`);
  coreLog.warn('sync', `refused with ${KNOWN_KEY}`);
  // Main holds no fingerprints: this one reaches the file, and the export's check leaves it out.
  mainLog.warn('accounts', `Couldn’t refresh: the server said ${KNOWN_KEY}`);
  mainLog.info('core', 'Started the Core (pid 42)');
}

describe('Export diagnostics', () => {
  it('writes versions, the Core, sync runs, settings and the log, and never a secret or content', async () => {
    store.saveFromSource({ source: 'gmail', account: 'google:1', items: [email()], deleted: [] });
    store.record({ type: 'create', item: { kind: 'todo', title: ITEM_TEXT } }, { by: { kind: 'user' } });
    couldntSyncIssue();
    const run = {
      account: 'github:1',
      source: 'github' as const,
      trigger: 'scheduled' as const,
      startedAt: T - 2_000,
      finishedAt: T - 1_000,
      outcome: 'failed' as const,
      created: 0,
      updated: 0,
      tombstoned: 0,
      unchanged: 0,
      requests: 1,
      complexity: null,
      error: `GitHub refused ${TOKEN}`,
    };
    store.syncState.recordRun(run);
    const { channel, secrets, offered, chosen } = wire();
    plantLogs(secrets);
    createLog({ dir: logsDir(dir), process: 'core', secrets, now: () => T + 2 }).warn(
      'sync',
      syncRunLine(run),
    );

    const response = await channel.request({ op: 'export' });
    expect(response).toMatchObject({ ok: true, exported: chosen });
    expect(offered).toEqual([exportFileName(T)]);
    const written = readFileSync(chosen, 'utf8');

    // What it is for.
    expect(written).toContain('# Commander diagnostics');
    expect(written).toContain('- Commander 0.1.0');
    expect(written).toContain('- Electron 44.5.1 · Chrome 150.0.0.0 · Node 24.1.0');
    expect(written).toContain('Password store: gnome-libsecret');
    expect(written).toMatch(/- Database: 00\d\d_\w+/);
    expect(written).toContain('- Restarts since Commander started: 1');
    expect(written).toContain('| github:1 | github | scheduled | failed |');
    expect(written).toContain('"autonomy"');
    expect(written).toContain(
      '- linear:acme (linear): 1 change; the latest: The issue is locked for editing.',
    );
    expect(written).toContain('The Core started (pid 42)');
    expect(written).toContain('Started the Core (pid 42)');
    expect(written).toContain(LEFT_OUT);

    // What it never holds.
    for (const secret of [
      TOKEN,
      BEARER_TOKEN,
      KNOWN_KEY,
      EMAIL_BODY,
      EMAIL_SUBJECT,
      ITEM_TEXT,
      ISSUE_TITLE,
      'Move to Done',
      'boathouse',
      'oat milk',
    ])
      expect(written).not.toContain(secret);
    // Only the User can read it.
    expect(statSync(chosen).mode & 0o077).toBe(0);
  });

  it('works while the Core is down, without what only the Core knows', async () => {
    const { channel, secrets, chosen } = wire({ coreDown: true });
    plantLogs(secrets);
    const response = await channel.request({ op: 'export' });
    expect(response).toMatchObject({ ok: true, report: null, exported: chosen });
    const written = readFileSync(chosen, 'utf8');
    expect(written).toContain('The Core didn’t answer');
    expect(written).toContain('Started the Core (pid 42)');
    expect(written).not.toContain(TOKEN);
    expect(written).not.toContain(BEARER_TOKEN);
  });

  it('writes nothing when the User cancels the picker', async () => {
    const { channel } = wire({ chosen: '' });
    await expect(channel.request({ op: 'export' })).resolves.toEqual({
      ok: true,
      report: null,
      exported: null,
    });
  });

  it('suggests a name in local time', () => {
    const at = new Date(2026, 9, 6, 0, 5).getTime();
    expect(exportFileName(at)).toBe('commander-diagnostics-2026-10-06-0005.md');
  });
});

describe('the report', () => {
  it('lists recent sync runs, newest first, and the database’s version', async () => {
    for (const [index, outcome] of (['synced', 'failed'] as const).entries())
      store.syncState.recordRun({
        account: `linear:${index}`,
        source: 'linear',
        trigger: 'refresh',
        startedAt: T + index,
        finishedAt: T + index + 10,
        outcome,
        created: 1,
        updated: 0,
        tombstoned: 0,
        unchanged: 0,
        requests: 1,
        complexity: 5,
        error: outcome === 'failed' ? 'Linear didn’t answer' : null,
      });
    const { channel } = wire();
    const response = await channel.request({ op: 'report' });
    if (!response.ok || !response.report) throw new Error('no report');
    expect(response.report.runs.map((run) => [run.account, run.outcome, run.error])).toEqual([
      ['linear:1', 'failed', 'Linear didn’t answer'],
      ['linear:0', 'synced', null],
    ]);
    expect(response.report.database.migration).toMatch(/^00\d\d_/);
  });

  it('is null while the Core is down', async () => {
    const { channel } = wire({ coreDown: true });
    await expect(channel.request({ op: 'report' })).resolves.toEqual({ ok: true, report: null });
  });
});
