import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ActionContext, FILE_INTO_PROJECTS, type Project, type SourceItem } from '@commander/domain';
import { createModelClient, type ModelProviderAdapter, type ProviderRequest } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { fileIntoProjectsJob } from './file-into-projects';
import { createFiling } from './filing';
import { learnExamples } from './learn-examples';
import { createJobRunner, type JobRunner } from './runner';
import { DAY, finishes, GITHUB, HOUR, issue, pullRequest } from './testing/github-fixtures';

// "File into Projects" on GitHub Items (#118), end to end through the runner: pull requests, issues
// and releases saved as GitHub sync saves them, in a real Item store, with the gate deciding. The
// model is a fake provider answering with recorded-style replies (GLM-5.3-Flash in JSON mode), keyed
// by the Item's title.

const user: ActionContext = { by: { kind: 'user' } };
const T = Date.UTC(2026, 9, 3, 9);
const API = { nodeId: 'R_api', owner: 'acme', name: 'titanlink-api' };
const WEB = { nodeId: 'R_web', owner: 'acme', name: 'web' };

let dir: string;
let clock: number;
let store: ItemStore;
let gate: Gate;
let runner: JobRunner;
let calls: ProviderRequest[];
// What the fake model answers for each Item, by its title.
let replies: Record<string, { projectCode: string; confidence: number; reason?: string }>;
let lt: Project;
let tl: Project;
let tx: Project;

const provider: ModelProviderAdapter = {
  async send(request) {
    calls.push(request);
    const content = request.messages.at(-1)?.content ?? '';
    const [, ref] = /label="(I\d+) · GitHub [^"]*"/.exec(content) ?? [];
    const [, title] = /┆ Title: (.*)/.exec(content) ?? [];
    const reply = title ? replies[title] : undefined;
    const filings = reply && ref ? [{ itemId: ref, ...reply }] : [];
    return {
      text: JSON.stringify({ filings, steering: [] }),
      usage: { inputTokens: 700, cachedTokens: 0, outputTokens: 40 },
    };
  },
  stream: () => Promise.reject(new Error('not used')),
};

function project(name: string, code: string): Project {
  return store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project as Project;
}

function inRepo(item: SourceItem, repo: typeof WEB): SourceItem {
  if (!item.detail || !('repo' in item.detail)) return item;
  return {
    ...item,
    externalId: item.externalId.replace('R_api', repo.nodeId),
    detail: { ...item.detail, repo },
  } as SourceItem;
}

function release(tag: string, publishedAt: number, notes = ''): SourceItem {
  return {
    externalId: `R_api:release/${tag}`,
    kind: 'github-release',
    title: `titanlink-api ${tag}`,
    status: 'done',
    detail: {
      kind: 'github-release',
      repo: API,
      tag,
      name: null,
      url: `https://github.com/acme/titanlink-api/releases/tag/${tag}`,
      author: 'priya',
      prerelease: false,
      publishedAt,
      notes,
    },
  };
}

function reviewRequest(number: number, title: string): SourceItem {
  return {
    externalId: `R_api:review-request/${number}`,
    kind: 'review-request',
    title,
    detail: {
      kind: 'review-request',
      pullRequest: `R_api:pull/${number}`,
      pullRequestId: null,
      repo: API,
      number,
      url: `https://github.com/acme/titanlink-api/pull/${number}`,
      direct: true,
      teams: [],
      requestedAt: clock,
    },
  };
}

// Saves GitHub Items as GitHub sync does, and returns their Item ids by title (a review request's
// title is its pull request's: the pull request's id it is).
function sync(...items: SourceItem[]): Record<string, string> {
  clock += 1000;
  store.saveFromSource({ source: 'github', account: GITHUB, items });
  const kinds = ['pull-request', 'github-issue', 'github-release'] as const;
  return Object.fromEntries(
    store.query({ source: 'github', kinds: [...kinds], limit: 1000 }).map((item) => [item.title, item.id]),
  );
}

const fileByHand = (itemId: string, into: Project) =>
  store.record(
    { type: 'update', itemId, changes: { filing: { projectId: into.id, filedBy: 'user' } } },
    user,
  );

const filingOf = (id: string | undefined) => store.get(id ?? '')?.item.filing ?? null;
const prompts = () => calls.map((call) => call.messages.at(-1)?.content ?? '');
const promptFor = (title: string) => prompts().find((each) => each.includes(`┆ Title: ${title}\n`)) as string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-file-github-'));
  clock = T;
  calls = [];
  replies = {};
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  // Who the User is on GitHub, so review requests make Todos.
  store.githubWatch.saveAccess(GITHUB, {
    via: 'token',
    login: 'octocat',
    orgs: [],
    personal: [],
    fetchedAt: T,
  });
  lt = project('Longtail', 'LT');
  tl = project('Titanlink', 'TL');
  tx = project('Tactics', 'TX');
  // "repo is acme/web → LT".
  store.changeRule({
    type: 'create',
    rule: {
      target: { kind: 'project', projectId: lt.id },
      when: { join: 'and', terms: [{ field: 'github.repo', op: 'is', value: 'R_web', label: 'acme/web' }] },
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

describe('File into Projects, on GitHub Items', () => {
  it('skips Rule-matched and hand-filed Items, and sends each pull request, issue and release in a data block of its own', async () => {
    const ids = sync(
      inRepo(pullRequest(clock, 1, 'Landing page'), WEB),
      pullRequest(clock, 12, 'Retry the relay'),
      issue(clock, 7, 'Relay drops messages'),
      issue(clock, 8, 'Docs are stale'),
      release('v2.0', clock - HOUR),
      reviewRequest(12, 'Retry the relay'),
    );
    expect(filingOf(ids['Landing page'])).toEqual({ projectId: lt.id, filedBy: 'rule' });
    fileByHand(ids['Docs are stale'] as string, tx);

    await run();

    // One call each for the pull request, the issue and the release; none for the review request,
    // which takes its pull request's Project.
    expect(prompts()).toHaveLength(3);
    expect(promptFor('Retry the relay')).toMatch(
      /<data-\w+ ref="U1" label="I1 · GitHub pull request acme\/titanlink-api#12" source="outside">/,
    );
    expect(promptFor('Relay drops messages')).toMatch(/label="I1 · GitHub issue acme\/titanlink-api#7"/);
    expect(promptFor('titanlink-api v2.0')).toMatch(/label="I1 · GitHub release acme\/titanlink-api v2.0"/);
    expect(prompts().some((each) => each.includes('Landing page'))).toBe(false);
    expect(prompts().some((each) => each.includes('Docs are stale'))).toBe(false);
    // The Projects and Rules are the User's own material.
    expect(prompts()[0]).toMatch(/label="Projects" source="the User">/);
    expect(prompts()[0]).toContain('Rule: repo is acme/web');
  });

  it('describes the Item: repo and org, labels, author and where their other Items are filed, a trimmed body and linked Items’ Projects', async () => {
    // Priya's other pull requests: two the User filed under TL, one Ares filed (which doesn't count).
    const earlier = sync(
      pullRequest(clock, 1, 'Older one'),
      pullRequest(clock, 2, 'Older two'),
      pullRequest(clock, 3, 'Older three'),
    );
    fileByHand(earlier['Older one'] as string, tl);
    fileByHand(earlier['Older two'] as string, tl);
    store.record(
      {
        type: 'update',
        itemId: earlier['Older three'] as string,
        changes: { filing: { projectId: tx.id, filedBy: 'ares' } },
      },
      { by: { kind: 'ares' } },
    );
    const ids = sync(
      pullRequest(clock, 12, 'Retry the relay', {
        labels: [
          { name: 'infra', color: 'aaaaaa' },
          { name: 'perf', color: 'bbbbbb' },
        ],
        body: `Retries the relay with backoff. ${'More words. '.repeat(200)}`,
      }),
    );
    // The Linear issue it finishes, filed under TL: a strong hint.
    const linear = finishes(store, ids['Retry the relay'] as string, 'TL-9');
    fileByHand(linear, tl);
    calls = [];

    await run([ids['Retry the relay'] as string]);

    const prompt = promptFor('Retry the relay');
    expect(prompt).toContain('┆ GitHub pull request acme/titanlink-api#12 (open)');
    expect(prompt).toContain('┆ Repo: acme/titanlink-api');
    expect(prompt).toContain('┆ Org: acme');
    expect(prompt).toContain('┆ Labels: infra, perf');
    expect(prompt).toContain('┆ Author: priya');
    expect(prompt).toContain('┆ Where the author’s other GitHub Items are filed: TL (2)');
    expect(prompt).toContain('┆ Body: Retries the relay with backoff. More words.');
    expect(prompt).not.toMatch(/(More words\. ){80}/);
    expect(prompt).toContain('┆ Linked Items’ Projects: TL (a Linear issue)');
  });

  it('files a confident Item as Ares, leaves a dashed Badge on a less confident one (on its review request and Todo too), and follows the GitHub Autonomy setting', async () => {
    replies = {
      'Retry the relay': { projectCode: 'TL', confidence: 0.93, reason: 'Titanlink’s API repo' },
      'Relay drops messages': { projectCode: 'TX', confidence: 0.6 },
    };
    const ids = sync(
      pullRequest(clock, 12, 'Retry the relay'),
      pullRequest(clock, 13, 'Speed up the relay', {
        requestedReviewers: [{ kind: 'user', login: 'octocat', requestedAt: clock }],
      }),
      reviewRequest(13, 'Speed up the relay'),
      issue(clock, 7, 'Relay drops messages'),
    );
    replies['Speed up the relay'] = { projectCode: 'TL', confidence: 0.55 };

    await run();

    const sure = ids['Retry the relay'] as string;
    expect(filingOf(sure)).toEqual({ projectId: tl.id, filedBy: 'ares' });
    expect(store.activity({ itemId: sure }).find((entry) => entry.by.kind === 'ares')).toMatchObject({
      action: 'update',
      why: 'Titanlink’s API repo',
    });
    const unsure = ids['Relay drops messages'] as string;
    expect(filingOf(unsure)).toBeNull();
    const [pending] = gate.activity({ itemId: unsure, statuses: ['pending'] });
    expect(pending).toMatchObject({ action: FILE_INTO_PROJECTS, decision: 'ask', section: 'github' });
    expect(store.get(unsure)?.item.filingSuggestion).toEqual({ proposalId: pending?.id, projectId: tx.id });

    // The pull request a review is asked of: its review request (the Dashboard's row) and its Todo
    // wear the pull request's dashed Badge; Confirm files the pull request, and both follow it.
    const pull = ids['Speed up the relay'] as string;
    const [asked] = gate.activity({ itemId: pull, statuses: ['pending'] });
    const request = store.query({ kinds: ['review-request'] })[0];
    const todo = store.query({ kinds: ['todo'] })[0];
    expect(request?.filingSuggestion).toEqual({ proposalId: asked?.id, projectId: tl.id });
    expect(todo?.filingSuggestion).toEqual({ proposalId: asked?.id, projectId: tl.id });
    createFiling({ itemStore: store, gate }).settle(asked?.id as number, tl.id);
    expect(filingOf(pull)).toEqual({ projectId: tl.id, filedBy: 'user' });
    expect(filingOf(request?.id)).toEqual({ projectId: tl.id, filedBy: 'inherited' });
    expect(filingOf(todo?.id)).toEqual({ projectId: tl.id, filedBy: 'inherited' });
    expect(store.filing.feedback()[0]).toMatchObject({ kind: 'confirmation', itemId: pull });

    // With Organise at Ask in GitHub, even a sure filing waits for the User.
    gate.setLevel({ scope: 'section', section: 'github', actionKind: 'organise' }, 'ask');
    replies['Rotate keys'] = { projectCode: 'TL', confidence: 0.97 };
    const more = sync(issue(clock, 9, 'Rotate keys'));
    await run([more['Rotate keys'] as string]);
    expect(filingOf(more['Rotate keys'])).toBeNull();
    expect(gate.activity({ itemId: more['Rotate keys'], statuses: ['pending'] })).toHaveLength(1);

    // Off in GitHub: GitHub Items aren't even sent.
    gate.setLevel({ scope: 'section', section: 'github', actionKind: 'organise' }, 'off');
    calls = [];
    sync(issue(clock, 10, 'Brand new'));
    await run();
    expect(calls).toHaveLength(0);
  });

  it('looks at open work and what changed lately, not old closed work', async () => {
    sync(
      pullRequest(clock, 1, 'Merged today', {
        state: 'merged',
        mergedAt: clock - HOUR,
        updatedAt: clock - HOUR,
      }),
      pullRequest(clock, 2, 'Merged long ago', {
        state: 'merged',
        mergedAt: clock - 60 * DAY,
        updatedAt: clock - 60 * DAY,
      }),
      issue(clock, 3, 'Closed long ago', {
        state: 'closed',
        closedAt: clock - 60 * DAY,
        updatedAt: clock - 60 * DAY,
      }),
      issue(clock, 4, 'Open for ages', { updatedAt: clock - 90 * DAY }),
      release('v1.0', clock - 90 * DAY),
    );

    await run();

    expect(
      prompts()
        .map((each) => /┆ Title: (.*)/.exec(each)?.[1])
        .sort(),
    ).toEqual(['Merged today', 'Open for ages']);
  });

  it('considers each Item once: a new body or more comments don’t send it again, a new label does', async () => {
    const ids = sync(issue(clock, 7, 'Relay drops messages'));
    await run();
    expect(calls).toHaveLength(1);

    calls = [];
    sync(issue(clock, 7, 'Relay drops messages', { body: 'Edited', commentCount: 4, updatedAt: clock }));
    await run(Object.values(ids));
    expect(calls).toHaveLength(0);

    sync(issue(clock, 7, 'Relay drops messages', { labels: [{ name: 'titanlink', color: 'ffffff' }] }));
    await run(Object.values(ids));
    expect(calls).toHaveLength(1);
  });
});

describe('File into Projects on GitHub Items, with Memory (#74)', () => {
  it('learns the User’s answer about one pull request by its repo, and reads it as their own for the next from that repo', async () => {
    // Ares guessed TL for the first pull request; the User corrected it to TX.
    replies = { 'Pager rota': { projectCode: 'TL', confidence: 0.55 } };
    const first = sync(pullRequest(clock, 12, 'Pager rota', { labels: [{ name: 'ops', color: 'aaaaaa' }] }))[
      'Pager rota'
    ] as string;
    await run();
    const [suggestion] = gate.activity({ itemId: first, statuses: ['pending'] });
    createFiling({ itemStore: store, gate }).settle(suggestion?.id as number, tx.id);
    expect(learnExamples(store)).toBe(1);

    calls = [];
    const second = sync(pullRequest(clock, 13, 'Pager handover'))['Pager handover'] as string;
    await run([second]);

    const prompt = promptFor('Pager handover');
    expect(prompt).toMatch(/label="What Ares knows" source="the User">/);
    expect(prompt).toContain(
      '- (example) GitHub pull request acme/titanlink-api#12 (repo acme/titanlink-api · ops · by priya) belongs to TX (Tactics), not TL (Titanlink)',
    );
  });
});
