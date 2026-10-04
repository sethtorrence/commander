import type { LinearCatalog, SourceItem } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import {
  type AccessToken,
  type FieldChange,
  RateLimited,
  SignInRefused,
  SourceUnavailable,
  WriteRejected,
} from '../source';
import { createLinearSource } from './linear-source';
import firstSync from './recorded/first-sync.json';
import refusals from './recorded/refusals.json';
import recorded from './recorded/writes.json';

// Linear's write side (Two-way sync) against recorded GraphQL responses, shaped as Linear answers.
// The issue as recorded: Priya moved its priority from 2 to 3 at 10:30 and added the Bug label at
// 11:00 on 3 October; nothing else changed since it was started.

type Recorded = { status: number; headers: Record<string, string>; body: unknown };
type Sent = { authorization: string | null; operationName: string; variables: Record<string, unknown> };

const NOW = Date.UTC(2026, 9, 3, 12);
const at = (hour: number, minute = 0) => Date.UTC(2026, 9, 3, hour, minute);
const apiKey: AccessToken = { token: 'lin_api_recorded', kind: 'api-key' };
const PRIYA = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: 'priya@acme.test' };
const SAM = { id: 'user-sam', name: 'Sam Rivera', displayName: 'sam', email: 'sam@acme.test' };
const customer = { id: 'label-customer', name: 'Customer', color: '#5e6ad2' };
const bug = { id: 'label-bug', name: 'Bug', color: '#eb5757' };

// Answers each request with the next response, in order, and keeps what was sent.
function linear(...responses: Recorded[]) {
  const queue = [...responses];
  const sent: Sent[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Omit<Sent, 'authorization'>;
    sent.push({ authorization: new Headers(init?.headers).get('authorization'), ...body });
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected request ${body.operationName}`);
    return new Response(next.body === null ? 'Service Unavailable' : JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers,
    });
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    sent,
    operations: () => sent.map((request) => request.operationName),
    remaining: () => queue.length,
  };
}

function write(fake: ReturnType<typeof linear>, changes: FieldChange[]) {
  const source = createLinearSource({
    apiUrl: () => 'https://linear.test/graphql',
    fetch: fake.fetch,
    now: () => NOW,
  });
  if (!source.write) throw new Error('The Linear adapter writes');
  return source.write({
    account: 'linear:org-acme',
    externalId: 'issue-418',
    changes,
    accessToken: async () => apiKey,
    signal: new AbortController().signal,
  });
}

const change = (field: string, value: unknown, synced: unknown, madeAt: number): FieldChange => ({
  field,
  value,
  synced,
  madeAt,
});
const sentInput = (fake: ReturnType<typeof linear>) =>
  fake.sent.find((request) => request.operationName === 'CommanderIssueUpdate')?.variables;
const detailOf = (item: SourceItem | null) => item?.detail as Record<string, unknown>;

describe('writing the User’s changes', () => {
  it('sends only the fields that changed, as the User, and hands back the issue as Linear has it now', async () => {
    const fake = linear(recorded.issueForWrite, recorded.issueUpdated);
    const result = await write(fake, [
      change('priority', 1, 3, at(11, 30)),
      change('estimate', 5, 3, at(11, 30)),
    ]);

    expect(fake.operations()).toEqual(['CommanderIssueForWrite', 'CommanderIssueUpdate']);
    expect(sentInput(fake)).toEqual({ id: 'issue-418', input: { priority: 1, estimate: 5 } });
    expect(fake.sent.every((request) => request.authorization === 'lin_api_recorded')).toBe(true);
    expect(result.superseded).toEqual([]);
    expect(detailOf(result.item)).toMatchObject({ priority: 1, estimate: 5 });
    expect(result.cost).toEqual({ requests: 2, complexity: 236 });
  });

  it('turns each field into Linear’s input: ids for state, assignee, cycle and Linear project, null to clear', async () => {
    const fake = linear(recorded.issueForWrite, recorded.issueUpdated);
    await write(fake, [
      change(
        'state',
        { id: 'state-review', name: 'In Review', type: 'started', color: '#0f783c' },
        null,
        at(11, 30),
      ),
      change('assignee', null, PRIYA, at(11, 30)),
      change('dueDate', '2026-10-16', '2026-10-09', at(11, 30)),
      change('estimate', null, 3, at(11, 30)),
      change(
        'cycle',
        { id: 'cycle-13', number: 13, name: 'Polish', startsAt: 0, endsAt: 1 },
        null,
        at(11, 30),
      ),
      change('linearProject', { id: 'project-audit', name: 'Audit trail' }, null, at(11, 30)),
    ]);

    expect(sentInput(fake)).toEqual({
      id: 'issue-418',
      input: {
        stateId: 'state-review',
        assigneeId: null,
        dueDate: '2026-10-16',
        estimate: null,
        cycleId: 'cycle-13',
        projectId: 'project-audit',
      },
    });
  });

  it('sends labels as add and remove deltas, never the whole list', async () => {
    const fake = linear(recorded.issueForWrite, recorded.issueUpdated);
    await write(fake, [
      change('label:label-customer', customer, null, at(11, 30)),
      change('label:label-bug', null, bug, at(11, 30)),
    ]);

    expect(sentInput(fake)).toEqual({
      id: 'issue-418',
      input: { addedLabelIds: ['label-customer'], removedLabelIds: ['label-bug'] },
    });
  });

  it('reads every page of the issue’s history before deciding', async () => {
    const fake = linear(recorded.issueForWriteHistoryPaged, recorded.issueHistorySecondPage);
    const result = await write(fake, [change('priority', 1, 2, at(10))]);

    expect(fake.operations()).toEqual(['CommanderIssueForWrite', 'CommanderIssueHistory']);
    expect(fake.sent[1]?.variables).toEqual({ id: 'issue-418', after: 'h1' });
    expect(result.superseded).toEqual([{ field: 'priority', by: 'Priya Patel', at: at(10, 30) }]);
  });
});

describe('conflicts: the newer change wins, per field', () => {
  it('drops the User’s change when Linear changed the field after it, and says who did and when', async () => {
    const fake = linear(recorded.issueForWrite);
    const result = await write(fake, [change('priority', 1, 2, at(10))]);

    expect(fake.operations()).toEqual(['CommanderIssueForWrite']);
    expect(result.superseded).toEqual([{ field: 'priority', by: 'Priya Patel', at: at(10, 30) }]);
    expect(detailOf(result.item)).toMatchObject({ priority: 3 });
  });

  it('sends the User’s change when it is newer than Linear’s', async () => {
    const fake = linear(recorded.issueForWrite, recorded.issueUpdated);
    const result = await write(fake, [change('priority', 1, 2, at(10, 45))]);

    expect(sentInput(fake)).toEqual({ id: 'issue-418', input: { priority: 1 } });
    expect(result.superseded).toEqual([]);
  });

  it('keeps changes to different fields both, even when one of them loses', async () => {
    const fake = linear(recorded.issueForWrite, recorded.issueUpdated);
    const result = await write(fake, [change('priority', 1, 2, at(10)), change('estimate', 5, 3, at(10))]);

    expect(sentInput(fake)).toEqual({ id: 'issue-418', input: { estimate: 5 } });
    expect(result.superseded.map((lost) => lost.field)).toEqual(['priority']);
  });

  it('neither sends nor drops a change Linear already has, as when a retry follows a lost answer', async () => {
    const fake = linear(recorded.issueForWrite);
    const result = await write(fake, [
      change('priority', 3, 2, at(10)),
      change('label:label-bug', bug, null, at(10)),
    ]);

    expect(fake.operations()).toEqual(['CommanderIssueForWrite']);
    expect(result.superseded).toEqual([]);
    expect(detailOf(result.item)).toMatchObject({ priority: 3 });
  });

  it('judges each label on its own', async () => {
    const fake = linear(recorded.issueForWrite, recorded.issueUpdated);
    const result = await write(fake, [
      change('label:label-bug', null, bug, at(10, 45)),
      change('label:label-customer', customer, null, at(10, 45)),
    ]);

    expect(sentInput(fake)).toEqual({ id: 'issue-418', input: { addedLabelIds: ['label-customer'] } });
    expect(result.superseded).toEqual([{ field: 'label:label-bug', by: 'Priya Patel', at: at(11) }]);
  });
});

describe('comments', () => {
  const mine = {
    id: recorded.commentId,
    author: SAM,
    body: 'On it, fixing the redirect.',
    createdAt: at(12, 1),
    updatedAt: at(12, 1),
  };

  it('post with Commander’s own id for the comment', async () => {
    const fake = linear(recorded.issueForWrite, recorded.commentCreated, recorded.issueWithMyComment);
    const result = await write(fake, [change(`comment:${mine.id}`, mine, null, at(12, 1))]);

    expect(fake.operations()).toEqual(['CommanderIssueForWrite', 'CommanderCommentCreate', 'CommanderIssue']);
    expect(fake.sent[1]?.variables).toEqual({
      input: { id: mine.id, issueId: 'issue-418', body: 'On it, fixing the redirect.' },
    });
    expect((detailOf(result.item).comments as { id: string }[]).map((comment) => comment.id)).toEqual([
      'comment-1',
      mine.id,
    ]);
  });

  it('are never posted twice: a retry finds the comment already in Linear', async () => {
    const fake = linear(recorded.issueForWriteWithMyComment);
    const result = await write(fake, [change(`comment:${mine.id}`, mine, null, at(12, 1))]);

    expect(fake.operations()).toEqual(['CommanderIssueForWrite']);
    expect(result.superseded).toEqual([]);
  });

  it('taken back by the User are deleted in Linear', async () => {
    const fake = linear(
      recorded.issueForWriteWithMyComment,
      recorded.commentDeleted,
      recorded.issueAfterTakeBack,
    );
    await write(fake, [change(`comment:${mine.id}`, null, mine, at(12, 5))]);

    expect(fake.operations()).toEqual(['CommanderIssueForWrite', 'CommanderCommentDelete', 'CommanderIssue']);
    expect(fake.sent[1]?.variables).toEqual({ id: mine.id });
  });
});

describe('when Linear won’t take the change', () => {
  it('reports a refusal it won’t change its mind about as WriteRejected, in Linear’s words', async () => {
    const fake = linear(recorded.issueForWrite, recorded.stateRefused);
    const writing = write(fake, [
      change('state', { id: 'state-ops', name: 'Ops', type: 'started', color: '#000' }, null, at(11, 30)),
    ]);

    await expect(writing).rejects.toThrow(WriteRejected);
    await expect(
      write(linear(recorded.issueForWrite, recorded.stateRefused), [change('priority', 0, 3, at(12))]),
    ).rejects.toThrow("Linear refused the change: The workflow state does not belong to the issue's team.");
  });

  it('reports an issue Linear no longer has as WriteRejected', async () => {
    await expect(write(linear(recorded.issueNotFound), [change('priority', 1, 3, at(12))])).rejects.toThrow(
      'Linear refused the change: Could not find referenced Issue.',
    );
  });

  it('reports rate limits, refused sign-ins and server trouble as for syncs, to retry', async () => {
    await expect(
      write(linear(refusals.tooManyRequests), [change('priority', 1, 3, at(12))]),
    ).rejects.toBeInstanceOf(RateLimited);
    await expect(
      write(linear(refusals.unauthenticated), [change('priority', 1, 3, at(12))]),
    ).rejects.toBeInstanceOf(SignInRefused);
    await expect(
      write(linear(refusals.serverError), [change('priority', 1, 3, at(12))]),
    ).rejects.toBeInstanceOf(SourceUnavailable);
  });
});

describe('what the pickers offer', () => {
  type Exchange = { response: Recorded };

  async function syncWithCatalog(...extra: Recorded[]) {
    const fake = linear(...(firstSync as Exchange[]).map((exchange) => exchange.response), ...extra);
    const catalogs: LinearCatalog[] = [];
    const source = createLinearSource({
      apiUrl: () => 'https://linear.test/graphql',
      fetch: fake.fetch,
      now: () => NOW,
    });
    const result = await source.sync({
      account: 'linear:org-acme',
      cursor: null,
      accessToken: async () => apiKey,
      save: () => {},
      saveCatalog: (catalog) => catalogs.push(catalog),
      signal: new AbortController().signal,
    });
    return { fake, catalogs, result };
  }

  it('is fetched with each sync: each team’s states in order, active members, its labels and the workspace’s, cycles not yet over', async () => {
    const { fake, catalogs } = await syncWithCatalog(recorded.catalog);

    expect(fake.operations().at(-1)).toBe('CommanderCatalog');
    expect(fake.sent.at(-1)?.variables).toEqual({ cycles: { endsAt: { gt: '2026-10-03T12:00:00.000Z' } } });
    expect(catalogs).toEqual([
      {
        kind: 'linear',
        teams: [
          {
            id: 'team-eng',
            key: 'ENG',
            name: 'Engineering',
            states: ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done'].map((name) =>
              expect.objectContaining({ name }),
            ),
            members: [PRIYA, SAM],
            labels: [bug, customer],
            cycles: [
              expect.objectContaining({ number: 12 }),
              expect.objectContaining({ number: 13, name: 'Polish' }),
            ],
            linearProjects: [
              { id: 'project-audit', name: 'Audit trail' },
              { id: 'project-login', name: 'Login revamp' },
            ],
          },
        ],
      },
    ]);
  });

  it('never fails a sync whose issues arrived', async () => {
    const { catalogs, result } = await syncWithCatalog(refusals.serverError);
    expect(catalogs).toEqual([]);
    expect(result.cursor).not.toBeNull();
  });
});
