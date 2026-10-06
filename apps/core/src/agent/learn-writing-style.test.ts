import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEARN_WRITING_STYLE, writingStyleKey } from '@commander/domain';
import { createModelClient, type ModelProviderAdapter, type ProviderRequest } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { allowCloudMail, DAY, deliver, GMAIL, type MailInput, OUTLOOK } from './fixtures/emails';
import { learnWritingStyleJob, STYLE_EVERY_MS } from './learn-writing-style';
import { createJobRunner, type JobRunner } from './runner';

// "Learn writing style" (#143), through the runner: the User's sent mail saved as Gmail and Outlook
// sync save it, in a real Item store. The model is a fake provider with recorded-style replies, one
// per Account (told apart by the address in the sample).

const T = Date.UTC(2026, 9, 7, 9);
const ALEX = { name: 'Alex Kim', address: 'alex@acme.test' };
const ALEX_OUTLOOK = { name: 'Alex Kim', address: 'alex@contoso.test' };
const DANA = { name: 'Dana Whitfield', address: 'dana@acme.test' };
const LEE = { name: 'Lee Park', address: 'lee@northwind.test' };

const GMAIL_STYLE =
  'Short and warm. With colleagues: "Hi Dana," and signs off "Cheers, Alex". With outsiders: "Hello Lee," and "Best regards, Alex Kim".';
const OUTLOOK_STYLE = 'Brisk and formal; no greeting; signs off "Thanks, A."';

let dir: string;
let clock: number;
let store: ItemStore;
let runner: JobRunner;
let calls: ProviderRequest[];
let replies: { gmail: string; outlook: string };

const provider: ModelProviderAdapter = {
  async send(request) {
    calls.push(request);
    const content = request.messages.at(-1)?.content ?? '';
    const style =
      content.includes('Contoso') || content.includes('contoso') ? replies.outlook : replies.gmail;
    return {
      text: JSON.stringify({ style, steering: [] }),
      usage: { inputTokens: 1_500, cachedTokens: 0, outputTokens: 60 },
    };
  },
  stream: () => Promise.reject(new Error('not used')),
};

const prompts = () => calls.map((call) => call.messages.at(-1)?.content ?? '');

function sent(id: string, fields: Partial<MailInput> = {}): MailInput {
  return {
    id,
    from: ALEX,
    to: [DANA],
    sentByMe: true,
    subject: `About ${id}`,
    text: `Hi Dana,\n\nNotes on ${id}.\n\nCheers,\nAlex\n\nOn Mon, Dana wrote:\n> THEIR-WORDS-${id}`,
    labels: [{ id: 'SENT', name: 'Sent' }],
    inInbox: false,
    ...fields,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-learn-writing-style-'));
  clock = T;
  calls = [];
  replies = { gmail: GMAIL_STYLE, outlook: OUTLOOK_STYLE };
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  allowCloudMail(store);
  runner = createJobRunner({
    jobs: [learnWritingStyleJob(store, { now: () => clock })],
    client: createModelClient({
      settings: () => store.models.settings(),
      providers: { zai: provider },
      ledger: store.models,
      now: () => clock,
    }),
    gate: openGate({ itemStore: store }),
    store: store.agent,
    injectionWarnings: store.injectionWarnings,
    now: () => clock,
    log: () => {},
    tickMs: null,
  });
  deliver(store, clock, [
    sent('one'),
    sent('two', { to: [LEE], text: 'Hello Lee,\n\nThe contract is signed.\n\nBest regards,\nAlex Kim' }),
    sent('three', {
      attachments: [{ partId: '2', name: 'plan.pdf', type: 'application/pdf', size: 10, inline: false }],
    }),
    sent('forward', {
      subject: 'Fwd: Their newsletter',
      text: 'FYI\n\n---------- Forwarded message ---------\nFORWARDED-WORDS',
    }),
    sent('old', { sentAt: clock - 40 * DAY }),
    { id: 'incoming', from: DANA, to: [ALEX], subject: 'Lunch?', text: 'DANAS-OWN-WORDS' },
  ]);
  deliver(
    store,
    clock,
    ['a', 'b', 'c'].map((id) =>
      sent(`o-${id}`, {
        from: ALEX_OUTLOOK,
        to: [{ name: 'Contoso team', address: 'team@contoso.test' }],
        text: `Done ${id}.\n\nThanks, A.`,
      }),
    ),
    { account: OUTLOOK, source: 'outlook' },
  );
});

afterEach(() => {
  runner.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function idle() {
  runner.trigger({ kind: 'idle' });
  await runner.settled();
}

describe('Learn writing style', () => {
  it('keeps one confirmed preference per Account, from the User’s own sent words, shown on What Ares knows', async () => {
    await idle();

    // One Quick call per Account, at low thinking, on the Usage page under its own name.
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.reasoningEffort === 'low')).toBe(true);
    expect(store.models.usageSummary().byJob.map((row) => row.job)).toEqual([LEARN_WRITING_STYLE]);
    const gmail = prompts().find((each) => !each.includes('Contoso')) as string;
    // Each sent message in an outside block of its own, whom it went to and whether they are colleagues.
    expect(gmail).toMatch(/ref="U1" label="S1 · The User’s sent email" source="outside">/);
    expect(gmail).toContain('To: Dana Whitfield (all in the User’s organisation)');
    expect(gmail).toContain('To: Lee Park (all outside the User’s organisation)');
    expect(gmail).toContain('The contract is signed.');
    // Only the User's own words: no quoted history, no forwards, nothing older than 30 days, no one
    // else's mail, never an attachment.
    expect(gmail).not.toContain('THEIR-WORDS');
    expect(gmail).not.toContain('FORWARDED-WORDS');
    expect(gmail).not.toContain('About old');
    expect(gmail).not.toContain('DANAS-OWN-WORDS');
    expect(gmail).not.toContain('plan.pdf');

    const style = store.memory.byKey(writingStyleKey(GMAIL));
    expect(style).toMatchObject({
      kind: 'preference',
      confirmed: true,
      by: 'ares',
      text: `Writing style for alex@acme.test: ${GMAIL_STYLE}`,
    });
    expect(style?.sources.length).toBeGreaterThan(0);
    expect(store.memory.byKey(writingStyleKey(OUTLOOK))?.text).toBe(
      `Writing style for alex@contoso.test: ${OUTLOOK_STYLE}`,
    );
    // What Ares knows lists them with his other memories.
    const listed = store.memory.list().memories.filter((memory) => memory.kind === 'preference');
    expect(listed.map((memory) => memory.text).sort()).toEqual(
      [
        `Writing style for alex@acme.test: ${GMAIL_STYLE}`,
        `Writing style for alex@contoso.test: ${OUTLOOK_STYLE}`,
      ].sort(),
    );
  });

  it('learns again weekly (or when asked), still one memory per Account, never over the User’s own edit', async () => {
    await idle();
    expect(calls).toHaveLength(2);

    // Within the week: nothing.
    clock += 2 * DAY;
    await idle();
    expect(calls).toHaveLength(2);

    // A week on: again, the words replaced, still one memory each.
    clock += STYLE_EVERY_MS;
    replies.gmail = 'Short and warm; signs off "Cheers, Alex".';
    await idle();
    expect(calls).toHaveLength(4);
    expect(store.memory.byKey(writingStyleKey(GMAIL))?.text).toBe(
      'Writing style for alex@acme.test: Short and warm; signs off "Cheers, Alex".',
    );
    expect(store.memory.list().memories.filter((memory) => memory.kind === 'preference')).toHaveLength(2);

    // The User edits it: learning again never overwrites their words.
    const id = store.memory.byKey(writingStyleKey(GMAIL))?.id as string;
    store.transaction(() =>
      store.memory.change({ type: 'edit', memoryId: id, text: 'Always brief. "Cheers, Alex".' }),
    );
    runner.run(LEARN_WRITING_STYLE);
    await runner.settled();
    expect(store.memory.byKey(writingStyleKey(GMAIL))?.text).toBe('Always brief. "Cheers, Alex".');
  });

  it('never learns again a style the User deleted', async () => {
    await idle();
    const id = store.memory.byKey(writingStyleKey(GMAIL))?.id as string;
    store.transaction(() => store.memory.change({ type: 'delete', memoryId: id }));
    calls = [];
    runner.run(LEARN_WRITING_STYLE);
    await runner.settled();
    expect(calls).toHaveLength(1);
    expect(prompts()[0]).toContain('Contoso');
    expect(store.memory.byKey(writingStyleKey(GMAIL))).toBeNull();
  });

  it('reads no Gmail mail the User hasn’t allowed, and needs a few messages before saying anything', async () => {
    allowCloudMail(store, GMAIL, 'declined');
    // Two of the Outlook Account's three gone from Outlook: too few to go on.
    store.saveFromSource({ source: 'outlook', account: OUTLOOK, items: [], deleted: ['o-b', 'o-c'] });
    await idle();
    expect(calls).toHaveLength(0);
    expect(store.memory.byKey(writingStyleKey(GMAIL))).toBeNull();
    expect(store.memory.byKey(writingStyleKey(OUTLOOK))).toBeNull();
  });

  it('keeps no link in the style', async () => {
    replies.gmail = 'Short. Shares https://alex.example/booking often. Signs off "Cheers".';
    await idle();
    expect(store.memory.byKey(writingStyleKey(GMAIL))?.text).toBe(
      'Writing style for alex@acme.test: Short. Shares often. Signs off "Cheers".',
    );
  });
});
