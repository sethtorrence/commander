import type { LinearIssueCreate, SourceItem } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { type AccessToken, type FieldChange, WriteRejected } from '../source';
import { createLinearSource } from './linear-source';
import recorded from './recorded/writes.json';

// Send to Linear, on Linear's side: a new issue's queued `create` (made with Commander's own id for
// the issue, so a retry never makes a second one) and an undone send's `delete`, against GraphQL
// responses shaped as Linear answers.

type Recorded = { status: number; headers: Record<string, string>; body: unknown };
type Sent = { operationName: string; variables: Record<string, unknown> };

const NOW = Date.UTC(2026, 9, 3, 12);
const apiKey: AccessToken = { token: 'lin_api_recorded', kind: 'api-key' };
const ID = '5b0f6c3e-7c4e-4c1a-9a3e-0d8f2b1c6a10';
const headers = { 'x-complexity': '12' };

// The recorded issue, as Linear has it once made with Commander's id.
const made = {
  ...recorded.issueUpdated.body.data.issueUpdate.issue,
  id: ID,
  identifier: 'ENG-512',
  title: 'Write the runbook',
  description: 'Steps first',
  priority: 2,
  estimate: null,
  dueDate: null,
  labels: { nodes: [] },
  cycle: null,
  project: null,
  comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
};
const ok = (data: unknown): Recorded => ({ status: 200, headers, body: { data } });
const found = (...nodes: unknown[]) =>
  ok({ issues: { nodes, pageInfo: { hasNextPage: false, endCursor: nodes.length ? ID : null } } });

function linear(...responses: Recorded[]) {
  const queue = [...responses];
  const sent: Sent[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Sent;
    sent.push(body);
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected request ${body.operationName}`);
    return new Response(JSON.stringify(next.body), { status: next.status, headers: next.headers });
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    sent,
    operations: () => sent.map((s) => s.operationName),
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
    externalId: ID,
    changes,
    accessToken: async () => apiKey,
    signal: new AbortController().signal,
  });
}

const input: LinearIssueCreate = {
  teamId: 'team-eng',
  title: 'Write the runbook',
  description: 'Steps first',
  assigneeId: 'user-priya',
  stateId: 'state-progress',
  priority: 2,
};
const create = (value: unknown = input): FieldChange => ({
  field: 'create',
  value,
  synced: null,
  madeAt: NOW,
});
const remove: FieldChange = { field: 'delete', value: true, synced: null, madeAt: NOW };
const detailOf = (item: SourceItem | null) => item?.detail as Record<string, unknown>;

describe('making a new issue', () => {
  it('creates it under Commander’s id, once it has checked Linear doesn’t have it yet, and hands it back', async () => {
    const fake = linear(found(), ok({ issueCreate: { success: true, issue: made } }));
    const result = await write(fake, [create()]);

    expect(fake.operations()).toEqual(['CommanderIssues', 'CommanderIssueCreate']);
    expect(fake.sent[0]?.variables).toMatchObject({ filter: { id: { in: [ID] } }, includeArchived: true });
    expect(fake.sent[1]?.variables).toEqual({ input: { id: ID, ...input } });
    expect(result.item).toMatchObject({ externalId: ID, title: 'Write the runbook' });
    expect(detailOf(result.item)).toMatchObject({ identifier: 'ENG-512', priority: 2 });
    expect(result.superseded).toEqual([]);
  });

  it('never makes a second issue: a retry after a lost answer finds the first one in Linear', async () => {
    const fake = linear(found(made));
    const result = await write(fake, [create()]);

    expect(fake.operations()).toEqual(['CommanderIssues']);
    expect(detailOf(result.item)).toMatchObject({ identifier: 'ENG-512' });
  });

  it('then sends changes made to it while it was on its way, as edits of the new issue', async () => {
    const fake = linear(
      found(),
      ok({ issueCreate: { success: true, issue: made } }),
      ok({ issue: { ...made, history: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }),
      ok({ issueUpdate: { success: true, issue: { ...made, priority: 1 } } }),
    );
    const result = await write(fake, [create(), { field: 'priority', value: 1, synced: 2, madeAt: NOW + 1 }]);

    expect(fake.operations()).toEqual([
      'CommanderIssues',
      'CommanderIssueCreate',
      'CommanderIssueForWrite',
      'CommanderIssueUpdate',
    ]);
    expect(fake.sent[3]?.variables).toEqual({ id: ID, input: { priority: 1 } });
    expect(detailOf(result.item)).toMatchObject({ priority: 1 });
  });

  it('refuses a creation it can’t make sense of, which retrying won’t fix', async () => {
    const fake = linear();
    await expect(write(fake, [create({ title: '' })])).rejects.toBeInstanceOf(WriteRejected);
    expect(fake.sent).toEqual([]);
  });
});

describe('deleting an issue whose send was undone', () => {
  it('deletes it in Linear', async () => {
    const fake = linear(found(made), ok({ issueDelete: { success: true } }));
    const result = await write(fake, [remove]);

    expect(fake.operations()).toEqual(['CommanderIssues', 'CommanderIssueDelete']);
    expect(fake.sent[1]?.variables).toEqual({ id: ID });
    expect(result.item).toBeNull();
  });

  it('does nothing when the issue never reached Linear, or is deleted there already', async () => {
    const never = linear(found());
    expect((await write(never, [create(), remove])).item).toBeNull();
    expect(never.operations()).toEqual(['CommanderIssues']);

    const gone = linear(found({ ...made, trashed: true }));
    await write(gone, [remove]);
    expect(gone.operations()).toEqual(['CommanderIssues']);
  });
});
