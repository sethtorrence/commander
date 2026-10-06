import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, Project, SummariseTarget } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowCloudMail, deliver } from '../agent/fixtures/emails';
import { pullRequest, syncGitHub } from '../agent/testing/github-fixtures';
import { syncIssues, writeBlock } from '../agent/testing/meeting-fixtures';
import { type ItemStore, openItemStore } from '../item-store';
import { createSummariseTarget } from './summarise';

// Summarise on what a Conversation names (#192): what Ares gathers to sum up, over a real Item store
// with its clock pinned.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const NOW = new Date(2026, 9, 6, 9, 0).getTime();
const DAY = 24 * 3_600_000;
const user: ActionContext = { by: { kind: 'user' } };

let dir: string;
let store: ItemStore;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  dir = mkdtempSync(join(tmpdir(), 'commander-summarise-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

const summarise = (input: SummariseTarget) =>
  createSummariseTarget({ itemStore: store, now: () => NOW })(input);
const titles = (found: Awaited<ReturnType<typeof summarise>>) => found.items.map(({ item }) => item.title);

function titanlink(): Project {
  return store.changeProject({ type: 'create', project: { name: 'Titanlink', code: 'TL', accent: 'blue' } })
    .project as Project;
}

// A line the User wrote `daysAgo`, filed under the Project.
function noteFiled(project: Project, text: string, daysAgo: number) {
  vi.setSystemTime(NOW - daysAgo * DAY);
  const id = writeBlock(store, '2026-10-01', text);
  store.record(
    { type: 'update', itemId: id, changes: { filing: { projectId: project.id, filedBy: 'user' } } },
    user,
  );
  vi.setSystemTime(NOW);
  return id;
}

describe('Summarise on what the User names', () => {
  it('gathers a Project’s Items over the last week unless the User says, newest first', async () => {
    const tl = titanlink();
    noteFiled(tl, 'Pricing page drafted', 2);
    noteFiled(tl, 'Kickoff with the client', 20);
    noteFiled(tl, 'Beta shipped', 1);

    const week = await summarise({ target: 'Titanlink' });
    expect(titles(week)).toEqual(['Beta shipped', 'Pricing page drafted']);
    expect(week.note).toBe(
      'Summarise gathered what is filed under the Project Titanlink (TL) over the last seven days: 2 Items.',
    );
    expect(week.items[0]?.text).toContain('Project: TL');
    expect(titles(await summarise({ target: 'tl', range: 'month' }))).toHaveLength(3);
  });

  it('takes “this sprint” as the Linear cycle under way among its Items', async () => {
    const tl = titanlink();
    const [issue] = syncIssues(store, [{ id: 'a', title: 'Rate limiter', people: [] }]);
    store.record(
      { type: 'update', itemId: issue as string, changes: { filing: { projectId: tl.id, filedBy: 'user' } } },
      user,
    );
    const saved = store.get(issue as string)?.item;
    if (saved?.detail?.kind !== 'linear-issue') throw new Error('No issue');
    store.saveFromSource({
      source: 'linear',
      account: 'linear:1',
      items: [
        {
          externalId: 'a',
          kind: 'linear-issue',
          title: saved.title,
          people: [],
          detail: {
            ...saved.detail,
            cycle: { id: 'c', number: 41, name: null, startsAt: NOW - 3 * DAY, endsAt: NOW + 4 * DAY },
          },
        },
      ],
    });
    noteFiled(tl, 'Before the cycle', 5);
    const sprint = await summarise({ target: 'Titanlink', range: 'sprint' });
    expect(titles(sprint)).toEqual(['Rate limiter']);
    expect(sprint.note).toMatch(/this sprint \(the current Linear cycle\)/);
  });

  it('gathers a GitHub repo’s pull requests, issues and releases, by owner/name or its name alone', async () => {
    syncGitHub(store, [pullRequest(NOW, 1, 'Retry webhooks'), pullRequest(NOW, 2, 'Bump node')]);
    const repo = await summarise({ target: 'acme/titanlink-api' });
    expect(titles(repo).sort()).toEqual(['Bump node', 'Retry webhooks']);
    expect(repo.note).toMatch(/GitHub repo acme\/titanlink-api over the last seven days: 2 Items/);
    expect(titles(await summarise({ target: 'titanlink-api' }))).toHaveLength(2);
  });

  it('gathers an email thread, every message oldest first, found by its words or as the Item he was shown', async () => {
    allowCloudMail(store);
    const ids = deliver(store, NOW, [
      { id: 'first', subject: 'Acme redlines', text: 'Here are the redlines.', sentAt: NOW - 2 * DAY },
      {
        id: 'second',
        subject: 'Re: Acme redlines',
        text: 'Clause 4 is fine.',
        sentAt: NOW - DAY,
        inReplyTo: '<first@mail.test>',
        references: ['<first@mail.test>'],
        threadKey: 'mid:<first@mail.test>',
      },
    ]);
    const thread = await summarise({ target: 'acme redlines thread' });
    expect(titles(thread)).toEqual(['Acme redlines', 'Re: Acme redlines']);
    expect(thread.note).toBe('Summarise gathered an email thread over all of it: 2 messages, oldest first.');
    expect(titles(await summarise({ target: `item:${ids.second}` }))).toEqual([
      'Acme redlines',
      'Re: Acme redlines',
    ]);
  });

  it('says plainly when nothing matches, rather than guessing', async () => {
    const nothing = await summarise({ target: 'Zeppelin' });
    expect(nothing.items).toEqual([]);
    expect(nothing.note).toBe(
      'Summarise found nothing in Commander matching “Zeppelin”: no Project, GitHub repo, email thread or Chat by that name.',
    );
  });
});
