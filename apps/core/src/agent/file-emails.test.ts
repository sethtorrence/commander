import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ActionContext, FILE_INTO_PROJECTS, type Project } from '@commander/domain';
import { createModelClient, type ModelProviderAdapter, type ProviderRequest } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { fileIntoProjectsJob } from './file-into-projects';
import { allowCloudMail, DAY, deliver, GMAIL, HOUR, type MailInput } from './fixtures/emails';
import { learnExamples } from './learn-examples';
import { createJobRunner, type JobRunner } from './runner';

// "File into Projects" on email (#141), through the runner: mail saved as Gmail sync saves it, in a
// real Item store, with the gate deciding. Emails no Rule files get Ares's filing or his dashed Badge,
// the same way Linear issues and Chats do. The model is a fake provider keyed by the subject.

const T = Date.UTC(2026, 9, 7, 9);
const user: ActionContext = { by: { kind: 'user' } };

let dir: string;
let clock: number;
let store: ItemStore;
let gate: Gate;
let runner: JobRunner;
let calls: ProviderRequest[];
let replies: Record<string, { projectCode: string; confidence: number; reason?: string }>;
let tl: Project;
let tx: Project;

const provider: ModelProviderAdapter = {
  async send(request) {
    calls.push(request);
    const content = request.messages.at(-1)?.content ?? '';
    const [, ref] = /label="(I\d+) · Email"/.exec(content) ?? [];
    const [, subject] = /┆ Subject: (.*)/.exec(content) ?? [];
    const reply = subject ? replies[subject] : undefined;
    return {
      text: JSON.stringify({ filings: reply && ref ? [{ itemId: ref, ...reply }] : [], steering: [] }),
      usage: { inputTokens: 800, cachedTokens: 0, outputTokens: 40 },
    };
  },
  stream: () => Promise.reject(new Error('not used')),
};

const prompts = () => calls.map((call) => call.messages.at(-1)?.content ?? '');
const send = (messages: MailInput[]) => deliver(store, clock, messages);
const filingOf = (id: string) => store.get(id)?.item.filing ?? null;

function project(name: string, code: string): Project {
  return store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project as Project;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-file-emails-'));
  clock = T;
  calls = [];
  replies = {};
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  allowCloudMail(store);
  tl = project('Titanlink', 'TL');
  tx = project('Tactics', 'TX');
  // "From domain is titanlink.io → TL".
  store.changeRule({
    type: 'create',
    rule: {
      target: { kind: 'project', projectId: tl.id },
      when: {
        join: 'and',
        terms: [{ field: 'gmail.domain', op: 'is', value: 'titanlink.io', label: 'titanlink.io' }],
      },
    },
  });
  gate = openGate({ itemStore: store });
  runner = createJobRunner({
    jobs: [fileIntoProjectsJob(store, { now: () => clock })],
    client: createModelClient({
      settings: () => store.models.settings(),
      providers: { zai: provider },
      ledger: store.models,
      now: () => clock,
    }),
    gate,
    store: store.agent,
    now: () => clock,
    log: () => {},
  });
});

afterEach(() => {
  runner.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function run(itemIds: string[] = []) {
  runner.trigger({ kind: 'items-arrived', itemIds });
  await runner.settled();
}

describe('File into Projects, on email', () => {
  it('skips mail a Rule filed or the User filed, and sends each other email in a block of its own', async () => {
    const ids = send([
      { id: 'omar', from: { name: 'Omar', address: 'omar@titanlink.io' }, subject: 'Relay rollout' },
      { id: 'mine', subject: 'Filed by hand' },
      {
        id: 'vendor',
        from: { name: 'Pat Vendor', address: 'pat@vendor.test' },
        cc: [{ name: 'Lee', address: 'lee@tactics.test' }],
        subject: 'Tactics renewal',
        text: `Renewal terms for the Tactics licence. ${'More terms. '.repeat(200)}END-OF-TERMS`,
      },
      { id: 'old', subject: 'Too old', sentAt: T - 40 * DAY },
    ]);
    store.record(
      {
        type: 'update',
        itemId: ids.mine as string,
        changes: { filing: { projectId: tx.id, filedBy: 'user' } },
      },
      user,
    );
    expect(filingOf(ids.omar as string)).toEqual({ projectId: tl.id, filedBy: 'rule' });

    await run();

    expect(prompts()).toHaveLength(1);
    const [prompt] = prompts() as [string];
    expect(prompt).toMatch(/<data-\w+ ref="U1" label="I1 · Email" source="outside">/);
    expect(prompt).toContain('┆ From: Pat Vendor ‹pat@vendor.test>');
    expect(prompt).toContain('┆ Sender’s domain: vendor.test');
    expect(prompt).toContain('┆ Cc: Lee ‹lee@tactics.test>');
    expect(prompt).toContain('┆ Subject: Tactics renewal');
    expect(prompt).toContain('┆ Text: Renewal terms for the Tactics licence.');
    expect(prompt).not.toContain('END-OF-TERMS');
    expect(prompt).toContain('Rule: from domain is titanlink.io');
  });

  it('files a confident email as Ares and leaves his dashed Badge on an unsure one, in the Email Section', async () => {
    replies = {
      'Tactics renewal': { projectCode: 'TX', confidence: 0.93, reason: 'The Tactics licence' },
      'Quick question': { projectCode: 'TL', confidence: 0.55 },
    };
    const ids = send([
      { id: 'vendor', subject: 'Tactics renewal' },
      { id: 'question', subject: 'Quick question', sentAt: T - 2 * HOUR },
    ]);

    await run();

    expect(filingOf(ids.vendor as string)).toEqual({ projectId: tx.id, filedBy: 'ares' });
    const unsure = ids.question as string;
    expect(filingOf(unsure)).toBeNull();
    const [pending] = gate.activity({ itemId: unsure, statuses: ['pending'] });
    expect(pending).toMatchObject({ action: FILE_INTO_PROJECTS, decision: 'ask', section: 'email' });
    expect(store.get(unsure)?.item.filingSuggestion).toEqual({ proposalId: pending?.id, projectId: tl.id });
  });

  it('a correction becomes an example naming the email by its sender', async () => {
    replies = { 'Quick question': { projectCode: 'TL', confidence: 0.55 } };
    const ids = send([{ id: 'question', subject: 'Quick question' }]);
    await run();
    store.record(
      {
        type: 'update',
        itemId: ids.question as string,
        changes: { filing: { projectId: tx.id, filedBy: 'user' } },
      },
      user,
    );
    learnExamples(store);
    expect(store.memory.list().memories.map((memory) => memory.text)).toContain(
      'Mail from dana@northwind.test belongs to TX (Tactics), not TL (Titanlink)',
    );
  });

  it('sends no Gmail mail before its Account’s consent', async () => {
    const settings = store.models.settings();
    store.models.saveSettings({ ...settings, cloudMail: { [GMAIL]: 'declined' } });
    send([{ id: 'vendor', subject: 'Tactics renewal' }]);
    await run();
    expect(calls).toHaveLength(0);
  });
});
