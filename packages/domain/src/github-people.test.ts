import { describe, expect, it } from 'vitest';
import type { GitHubRepoName, PullRequestDetail } from './github';
import { defaultOversightSettings } from './github-oversight';
import { type GitHubPeopleInput, githubPeople, type PersonWeek, peopleRange } from './github-people';
import type { Item } from './items';
import type { LinearIssueDetail } from './linear';
import type { Person } from './people';

// The People view's facts (#122): for a range and a scope, each Person active in the watched repos
// with what they merged, reviewed and opened, what is open and for how long (stuck by the summary's
// rules), the reviews waiting on them and their open Linear issues, ordered by name and never by
// numbers. From local Items and People only.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Sunday 4 October 2026, 15:00 UTC.
const NOW = Date.UTC(2026, 9, 4, 15);
// This week, from Monday 28 September (UTC).
const FROM = Date.UTC(2026, 8, 28);

const API: GitHubRepoName = { nodeId: 'R_api', owner: 'acme', name: 'api' };
const TITANLINK = 'p-titan';
const LONGTAIL = 'p-long';

let next = 0;

function item(kind: Item['kind'], title: string, detail: Item['detail'], projectId: string | null): Item {
  next += 1;
  return {
    id: `${kind}-${next}`,
    kind,
    source: kind === 'linear-issue' ? 'linear' : 'github',
    account: kind === 'linear-issue' ? 'linear:1' : 'github:1',
    externalId: `x-${next}`,
    title,
    people: [],
    filing: projectId ? { projectId, filedBy: 'rule' } : null,
    status: 'open',
    detail,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
}

function pr(
  changes: Partial<PullRequestDetail> & { title?: string; projectId?: string | null } = {},
): Item & { detail: PullRequestDetail } {
  const { title = 'A change', projectId = null, ...detail } = changes;
  const number = detail.number ?? next + 100;
  return item(
    'pull-request',
    title,
    {
      kind: 'pull-request',
      repo: API,
      number,
      url: `https://github.com/acme/api/pull/${number}`,
      nodeId: `PR_${number}`,
      author: 'priya',
      state: 'open',
      draft: false,
      baseBranch: 'main',
      headBranch: `branch-${number}`,
      labels: [],
      assignees: [],
      requestedReviewers: [],
      reviews: [],
      reviewDecision: null,
      checks: 'success',
      closingIssues: [],
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      body: '',
      createdAt: NOW - 2 * DAY,
      updatedAt: NOW - HOUR,
      mergedAt: null,
      closedAt: null,
      ...detail,
    },
    projectId,
  ) as Item & { detail: PullRequestDetail };
}

const merged = (at: number, changes: Parameters<typeof pr>[0] = {}) =>
  pr({ state: 'merged', mergedAt: at, closedAt: at, createdAt: at - DAY, ...changes });

function linear(
  identifier: string,
  assignee: string | null,
  changes: Partial<LinearIssueDetail> & { projectId?: string | null; title?: string } = {},
): Item {
  const { projectId = null, title = `Linear ${identifier}`, ...detail } = changes;
  return item(
    'linear-issue',
    title,
    {
      kind: 'linear-issue',
      identifier,
      url: `https://linear.app/acme/issue/${identifier}`,
      team: { id: 'team', key: 'ENG', name: 'Engineering' },
      state: { id: 's', name: 'In Progress', type: 'started', color: '#f2c94c' },
      priority: 2,
      assignee: assignee ? { id: assignee, name: assignee, displayName: assignee, email: null } : null,
      creator: null,
      labels: [],
      cycle: null,
      linearProject: null,
      dueDate: null,
      estimate: null,
      description: null,
      comments: [],
      createdAt: 0,
      updatedAt: 0,
      startedAt: null,
      completedAt: null,
      canceledAt: null,
      ...detail,
    },
    projectId,
  );
}

function person(id: string, name: string, handles: string[], isUser = false): Person {
  return {
    id,
    name,
    userName: null,
    isUser,
    handles: handles.map((handle) => ({
      handle,
      source: handle.startsWith('github:') ? 'github' : handle.startsWith('linear:') ? 'linear' : 'email',
      name: null,
    })),
    createdAt: 0,
    updatedAt: 0,
  };
}

const PRIYA = person('person-priya', 'Priya Raman', ['github:priya', 'linear:u-priya']);
const OMAR = person('person-omar', 'Omar Haddad', ['github:omar', 'linear:u-omar']);
const SAM = person('person-sam', 'Sam Rivera', ['github:sam', 'github:sam-work']);
const ME = person('person-me', 'Seth Torrence', ['github:seth'], true);
const PEOPLE = [PRIYA, OMAR, SAM, ME];

function people(input: Partial<GitHubPeopleInput>): PersonWeek[] {
  return githubPeople({
    range: { from: FROM, to: NOW },
    items: [],
    people: PEOPLE,
    settings: defaultOversightSettings,
    ...input,
  });
}

const ids = (list: { itemId: string }[]) => list.map((each) => each.itemId);
const cardOf = (weeks: PersonWeek[], name: string) => {
  const found = weeks.find((week) => week.name === name);
  if (!found) throw new Error(`No card for ${name} in ${weeks.map((week) => week.name).join(', ')}`);
  return found;
};

describe('Each Person’s week', () => {
  it('gives each active Person what they merged, reviewed, have open and are waited on for, by name', () => {
    const shipped = merged(NOW - 2 * DAY, { title: 'Retry webhooks', number: 11 });
    const alsoShipped = merged(NOW - DAY, { title: 'Back off retries', number: 12 });
    const lastWeek = merged(FROM - DAY, { title: 'Old work', number: 9 });
    // Open 12 days, asked of Omar 4 days ago: Stuck, waiting on him.
    const waiting = pr({
      title: 'Webhook signatures',
      number: 14,
      createdAt: NOW - 12 * DAY,
      updatedAt: NOW - HOUR,
      requestedReviewers: [{ kind: 'user', login: 'omar', requestedAt: NOW - 4 * DAY }],
    });
    // Omar reviewed Sam's in the range.
    const reviewedBySam = merged(NOW - 3 * DAY, {
      author: 'sam',
      title: 'Queue metrics',
      number: 15,
      reviews: [{ login: 'omar', state: 'approved', submittedAt: NOW - 3 * DAY - HOUR }],
    });
    const linearOpen = linear('ENG-412', 'u-priya', { title: 'Webhook retries' });
    const linearDone = linear('ENG-400', 'u-priya', {
      state: { id: 'd', name: 'Done', type: 'completed', color: '#000' },
    });

    const weeks = people({
      items: [shipped, alsoShipped, lastWeek, waiting, reviewedBySam, linearOpen, linearDone],
    });

    expect(weeks.map((week) => week.name)).toEqual(['Omar Haddad', 'Priya Raman', 'Sam Rivera']);
    const priya = cardOf(weeks, 'Priya Raman');
    expect(priya.personId).toBe(PRIYA.id);
    expect(priya.logins).toEqual(['priya']);
    // Newest first.
    expect(ids(priya.merged)).toEqual([alsoShipped.id, shipped.id]);
    expect(priya.merged[0]).toMatchObject({ identifier: 'acme/api#12', title: 'Back off retries' });
    expect(priya.reviewed).toEqual([]);
    expect(priya.open).toEqual([
      expect.objectContaining({
        itemId: waiting.id,
        identifier: 'acme/api#14',
        openDays: 12,
        draft: false,
        stuck: [{ kind: 'review-waiting', reviewer: 'omar', name: 'Omar Haddad', days: 4 }],
      }),
    ]);
    expect(priya.linear).toEqual([
      {
        itemId: linearOpen.id,
        identifier: 'ENG-412',
        title: 'Webhook retries',
        state: 'In Progress',
        stateType: 'started',
      },
    ]);

    const omar = cardOf(weeks, 'Omar Haddad');
    expect(ids(omar.reviewed)).toEqual([reviewedBySam.id]);
    expect(omar.waiting).toEqual([
      expect.objectContaining({ itemId: waiting.id, author: 'Priya Raman', waitDays: 4 }),
    ]);
    expect(ids(cardOf(weeks, 'Sam Rivera').merged)).toEqual([reviewedBySam.id]);
  });

  it('puts a Person’s logins on one card', () => {
    const one = merged(NOW - DAY, { author: 'sam' });
    const other = merged(NOW - 2 * DAY, { author: 'Sam-Work' });
    const [sam] = people({ items: [one, other] });
    expect(sam?.name).toBe('Sam Rivera');
    expect(sam?.logins).toEqual(['sam', 'sam-work']);
    expect(ids(sam?.merged ?? [])).toEqual([one.id, other.id]);
  });

  it('keeps an unmatched login as a card of its own, by the login', () => {
    const [someone] = people({ items: [merged(NOW - DAY, { author: 'newcomer' })] });
    expect(someone).toMatchObject({ key: 'github:newcomer', personId: null, name: 'newcomer' });
  });

  it('leaves out the User, bots and anyone with nothing in the watched repos in the range', () => {
    const weeks = people({
      items: [
        merged(NOW - DAY, { author: 'seth' }),
        merged(NOW - DAY, { author: 'dependabot[bot]' }),
        merged(NOW - DAY, { author: 'renovate' }),
        merged(FROM - DAY, { author: 'sam' }),
        // Linear issues alone don't make a week in the watched repos.
        linear('ENG-1', 'u-omar'),
      ],
    });
    expect(weeks).toEqual([]);
  });

  it('counts open pull requests and reviews waiting whenever they were opened or asked', () => {
    const old = pr({ author: 'sam', createdAt: NOW - 40 * DAY, updatedAt: NOW - 30 * DAY });
    const asked = pr({
      author: 'priya',
      createdAt: NOW - 40 * DAY,
      requestedReviewers: [{ kind: 'user', login: 'omar', requestedAt: NOW - 20 * DAY }],
    });
    const weeks = people({ items: [old, asked] });
    expect(weeks.map((week) => week.name)).toEqual(['Omar Haddad', 'Priya Raman', 'Sam Rivera']);
    expect(cardOf(weeks, 'Sam Rivera').open[0]?.stuck).toEqual([
      { kind: 'idle', openDays: 40, idleDays: 30 },
    ]);
    expect(cardOf(weeks, 'Omar Haddad').waiting[0]?.waitDays).toBe(20);
  });

  it('isn’t waiting on a reviewer who reviewed since being asked, or on a draft', () => {
    const reviewed = pr({
      requestedReviewers: [{ kind: 'user', login: 'omar', requestedAt: NOW - 3 * DAY }],
      reviews: [{ login: 'omar', state: 'commented', submittedAt: NOW - 2 * DAY }],
    });
    const draft = pr({
      draft: true,
      requestedReviewers: [{ kind: 'user', login: 'omar', requestedAt: NOW - 3 * DAY }],
    });
    const omar = cardOf(people({ items: [reviewed, draft] }), 'Omar Haddad');
    expect(omar.waiting).toEqual([]);
    expect(ids(omar.reviewed)).toEqual([reviewed.id]);
  });

  it('lists reviews waiting oldest first, and open pull requests longest open first', () => {
    const newer = pr({
      createdAt: NOW - 3 * DAY,
      requestedReviewers: [{ kind: 'user', login: 'omar', requestedAt: NOW - DAY }],
    });
    const older = pr({
      createdAt: NOW - 6 * DAY,
      requestedReviewers: [{ kind: 'user', login: 'omar', requestedAt: NOW - 5 * DAY }],
    });
    const young = pr({ createdAt: NOW - DAY });
    const aged = pr({ createdAt: NOW - 9 * DAY });
    const weeks = people({ items: [newer, older, young, aged] });
    expect(ids(cardOf(weeks, 'Omar Haddad').waiting)).toEqual([older.id, newer.id]);
    expect(ids(cardOf(weeks, 'Priya Raman').open)).toEqual([aged.id, older.id, newer.id, young.id]);
  });
});

describe('Plain marks for what is worth a look', () => {
  it('says how many reviews are waiting and the oldest, and how long a pull request has been open', () => {
    const asked = (days: number) =>
      pr({
        author: 'sam',
        requestedReviewers: [{ kind: 'user', login: 'omar', requestedAt: NOW - days * DAY }],
      });
    const longOpen = pr({ author: 'priya', createdAt: NOW - 12 * DAY, updatedAt: NOW - HOUR });
    const weeks = people({ items: [asked(1), asked(2), asked(4), longOpen] });
    expect(cardOf(weeks, 'Omar Haddad').marks).toEqual(['3 reviews waiting, oldest 4 days']);
    expect(cardOf(weeks, 'Priya Raman').marks).toEqual(['PR open 12 days']);
  });

  it('marks a lone review once it has waited past the summary’s rule, and stuck pull requests', () => {
    const asked = pr({
      author: 'sam',
      checks: 'failure',
      requestedReviewers: [{ kind: 'user', login: 'omar', requestedAt: NOW - 3 * DAY }],
    });
    const fresh = pr({
      author: 'priya',
      requestedReviewers: [{ kind: 'user', login: 'sam', requestedAt: NOW - HOUR }],
    });
    const weeks = people({ items: [asked, fresh] });
    expect(cardOf(weeks, 'Omar Haddad').marks).toEqual(['1 review waiting 3 days']);
    expect(cardOf(weeks, 'Sam Rivera').marks).toEqual(['1 PR stuck']);
    expect(cardOf(weeks, 'Priya Raman').marks).toEqual([]);
  });

  it('says several long-open pull requests together', () => {
    const weeks = people({
      items: [
        pr({ createdAt: NOW - 8 * DAY }),
        pr({ createdAt: NOW - 15 * DAY }),
        pr({ createdAt: NOW - DAY }),
      ],
    });
    expect(cardOf(weeks, 'Priya Raman').marks).toEqual(['2 PRs open over 7 days, oldest 15 days']);
  });
});

describe('Never ranked', () => {
  it('orders cards by name whatever the counts', () => {
    const busy = Array.from({ length: 6 }, (_, n) => merged(NOW - (n + 1) * HOUR, { author: 'sam' }));
    const weeks = people({
      items: [...busy, merged(NOW - DAY, { author: 'priya' }), merged(NOW - DAY, { author: 'omar' })],
      people: [
        person('b', 'bea', ['github:sam']),
        person('a', 'Álvaro', ['github:priya']),
        person('c', 'Carmen', ['github:omar']),
      ],
    });
    expect(weeks.map((week) => week.name)).toEqual(['Álvaro', 'bea', 'Carmen']);
  });
});

describe('The Project filter', () => {
  it('narrows each card to the Project’s work and hides People with none there', () => {
    const titan = merged(NOW - DAY, { author: 'priya', projectId: TITANLINK });
    const long = merged(NOW - DAY, { author: 'priya', projectId: LONGTAIL });
    const samLong = merged(NOW - DAY, { author: 'sam', projectId: LONGTAIL });
    const titanLinear = linear('ENG-1', 'u-priya', { projectId: TITANLINK });
    const longLinear = linear('ENG-2', 'u-priya', { projectId: LONGTAIL });

    const weeks = people({ items: [titan, long, samLong, titanLinear, longLinear], projectId: TITANLINK });
    expect(weeks.map((week) => week.name)).toEqual(['Priya Raman']);
    expect(ids(weeks[0]?.merged ?? [])).toEqual([titan.id]);
    expect(ids(weeks[0]?.linear ?? [])).toEqual([titanLinear.id]);

    const unfiled = people({ items: [titan, merged(NOW - DAY, { author: 'omar' })], projectId: null });
    expect(unfiled.map((week) => week.name)).toEqual(['Omar Haddad']);
  });
});

describe('One Person', () => {
  it('gives their card even with nothing in the range, the User’s too', () => {
    expect(people({ personId: SAM.id })).toEqual([
      expect.objectContaining({
        personId: SAM.id,
        name: 'Sam Rivera',
        logins: ['sam', 'sam-work'],
        merged: [],
      }),
    ]);
    expect(people({ personId: ME.id })).toEqual([expect.objectContaining({ isUser: true })]);
    expect(people({ personId: 'nobody' })).toEqual([]);
  });

  it('gives only theirs', () => {
    const weeks = people({
      items: [merged(NOW - DAY, { author: 'priya' }), merged(NOW - DAY, { author: 'omar' })],
      personId: OMAR.id,
    });
    expect(weeks.map((week) => week.name)).toEqual(['Omar Haddad']);
  });
});

describe('Ranges', () => {
  it('runs This week from Monday and Last 7 days from a week ago, to now', () => {
    expect(peopleRange('this-week', NOW, 'UTC')).toEqual({ from: FROM, to: NOW });
    expect(peopleRange('last-7-days', NOW, 'UTC')).toEqual({ from: NOW - 7 * DAY, to: NOW });
    expect(peopleRange('last-30-days', NOW, 'UTC')).toEqual({ from: NOW - 30 * DAY, to: NOW });
  });
});
