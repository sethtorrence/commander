import { describe, expect, it } from 'vitest';
import type { GitHubIssueDetail, GitHubRepoName } from './github';
import type { GitHubIssueItem } from './github-open-work';
import {
  changedIn,
  DEFAULT_SKILL_LABELS,
  isMap,
  isSkillLabelled,
  matchesSkillLabel,
  skillIssues,
} from './github-skill-issues';

// Skill-managed issues (#120): wayfinder maps and build tickets that stay open for weeks on purpose,
// recognised by their labels, found under their map (sub-issues, "Part of #N", the map's task list)
// or their milestone, and counted as progress. Shapes after this repo's own map (#1) and its M4
// milestone of `ready-for-agent` tickets.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 4, 15);
const FROM = Date.UTC(2026, 9, 3);

const REPO: GitHubRepoName = { nodeId: 'R_cmd', owner: 'sethtorrence', name: 'commander' };
const OTHER: GitHubRepoName = { nodeId: 'R_other', owner: 'acme', name: 'api' };

const label = (name: string) => ({ name, color: 'ededed' });
const ref = (number: number, repo = REPO) => ({
  owner: repo.owner,
  name: repo.name,
  number,
  title: `#${number}`,
  url: `https://github.com/${repo.owner}/${repo.name}/issues/${number}`,
});

function issue(
  number: number,
  changes: Partial<GitHubIssueDetail> & { title?: string; projectId?: string | null } = {},
): GitHubIssueItem {
  const { title = `Issue ${number}`, projectId = null, ...detail } = changes;
  const repo = detail.repo ?? REPO;
  return {
    id: `issue-${repo.name}-${number}`,
    kind: 'github-issue',
    source: 'github',
    account: 'github:1',
    externalId: `${repo.nodeId}:issue/${number}`,
    title,
    people: [],
    filing: projectId ? { projectId, filedBy: 'rule' } : null,
    status: detail.state === 'closed' ? 'done' : 'open',
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    detail: {
      kind: 'github-issue',
      repo,
      number,
      url: `https://github.com/${repo.owner}/${repo.name}/issues/${number}`,
      nodeId: `I_${repo.name}_${number}`,
      author: 'sethtorrence',
      assignees: [],
      labels: [],
      milestone: null,
      state: 'open',
      stateReason: null,
      body: '',
      commentCount: 0,
      createdAt: NOW - 40 * DAY,
      updatedAt: NOW - 10 * DAY,
      closedAt: null,
      parent: null,
      subIssues: null,
      ...detail,
    },
  } as GitHubIssueItem;
}

const closed = (at: number, reason: GitHubIssueDetail['stateReason'] = 'completed') => ({
  state: 'closed' as const,
  stateReason: reason,
  closedAt: at,
});
const map = (number: number, changes: Partial<GitHubIssueDetail> & { title?: string } = {}) =>
  issue(number, { title: 'Commander v1 map', labels: [label('wayfinder:map')], ...changes });

describe('recognising skill-managed issues', () => {
  it('knows the wayfinder labels and the five triage labels by default', () => {
    expect(DEFAULT_SKILL_LABELS).toEqual([
      'wayfinder:*',
      'needs-triage',
      'needs-info',
      'ready-for-agent',
      'ready-for-human',
      'wontfix',
    ]);
    for (const name of ['wayfinder:research', 'wayfinder:grilling', 'ready-for-agent', 'wontfix'])
      expect(isSkillLabelled({ labels: [label(name)] }, DEFAULT_SKILL_LABELS)).toBe(true);
    expect(isSkillLabelled({ labels: [label('bug'), label('enhancement')] }, DEFAULT_SKILL_LABELS)).toBe(
      false,
    );
    expect(isSkillLabelled({ labels: [] }, DEFAULT_SKILL_LABELS)).toBe(false);
  });

  it('reads a trailing * as any suffix, and matches whatever the case', () => {
    expect(matchesSkillLabel('wayfinder:task', 'wayfinder:*')).toBe(true);
    expect(matchesSkillLabel('Wayfinder:Map', 'wayfinder:*')).toBe(true);
    expect(matchesSkillLabel('wayfinder', 'wayfinder:*')).toBe(false);
    expect(matchesSkillLabel('my-wayfinder:task', 'wayfinder:*')).toBe(false);
    expect(matchesSkillLabel('Ready-For-Agent', 'ready-for-agent')).toBe(true);
    // A * anywhere else is just a character.
    expect(matchesSkillLabel('ready-for-agent', 'ready-*-agent')).toBe(false);
    expect(matchesSkillLabel('anything', '*')).toBe(true);
  });

  it('follows an edited list', () => {
    const edited = ['build:*', 'agent-ready'];
    expect(isSkillLabelled({ labels: [label('build:ticket')] }, edited)).toBe(true);
    expect(isSkillLabelled({ labels: [label('agent-ready')] }, edited)).toBe(true);
    expect(isSkillLabelled({ labels: [label('ready-for-agent')] }, edited)).toBe(false);
    expect(isSkillLabelled({ labels: [label('wayfinder:task')] }, [])).toBe(false);
  });

  it('finds a map by its wayfinder:map label', () => {
    expect(isMap({ labels: [label('wayfinder:map')] })).toBe(true);
    expect(isMap({ labels: [label('Wayfinder:Map')] })).toBe(true);
    expect(isMap({ labels: [label('wayfinder:task')] })).toBe(false);
    // A map is skill-managed whatever the list says.
    const found = skillIssues([map(1)], []);
    expect(found.groups.map((group) => group.key)).toEqual(['map:issue-commander-1']);
    expect(found.managed.has('issue-commander-1')).toBe(true);
  });
});

describe("a map's tickets", () => {
  it('are its sub-issues', () => {
    const one = map(1);
    const tickets = [
      issue(2, { labels: [label('wayfinder:research')], parent: ref(1) }),
      issue(3, { labels: [label('wayfinder:grilling')], parent: ref(1) }),
      // Not labelled, but under the map: a ticket all the same.
      issue(4, { parent: ref(1) }),
    ];
    const elsewhere = issue(5, { parent: ref(99) });
    const found = skillIssues([one, ...tickets, elsewhere], DEFAULT_SKILL_LABELS);
    expect(found.groups).toHaveLength(1);
    expect(found.groups[0]?.tickets.map((t) => t.detail.number)).toEqual([2, 3, 4]);
    expect(found.groupOf.get('issue-commander-4')).toBe('map:issue-commander-1');
    expect(found.managed.has('issue-commander-5')).toBe(false);
  });

  it('are the issues whose body starts with "Part of #N", where the repo has no sub-issues', () => {
    const one = map(1);
    const found = skillIssues(
      [
        one,
        issue(2, { body: 'Part of #1\n\nLook into the Gmail API.' }),
        issue(3, { body: '\n  **Part of** #1\n' }),
        issue(4, { body: 'Part of sethtorrence/commander#1' }),
        // Only at the top.
        issue(5, { body: 'Some text.\n\nPart of #1' }),
        // Another repo's #1.
        issue(1, { repo: OTHER, body: 'Part of #1' }),
      ],
      DEFAULT_SKILL_LABELS,
    );
    expect(found.groups[0]?.tickets.map((t) => t.id)).toEqual([
      'issue-commander-2',
      'issue-commander-3',
      'issue-commander-4',
    ]);
  });

  it("are the issues in the map's task list", () => {
    const one = map(1, {
      body: [
        '## Notes',
        'Planning for v1.',
        '- [x] #2',
        '- [ ] #3 Outlook research',
        '* [ ] https://github.com/sethtorrence/commander/issues/4',
        '- [ ] acme/api#7',
        '- a plain bullet #9',
      ].join('\n'),
    });
    const found = skillIssues(
      [one, issue(2), issue(3), issue(4), issue(7, { repo: OTHER }), issue(9)],
      DEFAULT_SKILL_LABELS,
    );
    expect(found.groups[0]?.tickets.map((t) => t.id)).toEqual([
      'issue-commander-2',
      'issue-commander-3',
      'issue-commander-4',
      'issue-api-7',
    ]);
  });

  it('group by milestone for build tickets with no map, under the milestone’s title', () => {
    const m4 = { title: 'M4 · GitHub', dueOn: null };
    const m3 = { title: 'M3 · Ares core', dueOn: null };
    const found = skillIssues(
      [
        issue(119, { labels: [label('ready-for-agent')], milestone: m4 }),
        issue(120, { labels: [label('ready-for-agent')], milestone: m4 }),
        issue(73, { labels: [label('ready-for-agent')], milestone: m3 }),
        // Not skill-managed: left alone, milestone or not.
        issue(200, { labels: [label('bug')], milestone: m4 }),
        // Skill-managed with neither map nor milestone: managed, in no group.
        issue(201, { labels: [label('needs-triage')] }),
      ],
      DEFAULT_SKILL_LABELS,
    );
    expect(
      found.groups.map((group) => [group.kind, group.title, group.tickets.map((t) => t.detail.number)]),
    ).toEqual([
      ['milestone', 'M3 · Ares core', [73]],
      ['milestone', 'M4 · GitHub', [119, 120]],
    ]);
    expect(found.managed.has('issue-commander-200')).toBe(false);
    expect(found.managed.has('issue-commander-201')).toBe(true);
    expect(found.groupOf.get('issue-commander-201')).toBeNull();
    expect(found.ticketKind('issue-commander-120')).toBe('build-ticket');
    expect(found.ticketKind('issue-commander-201')).toBe('ticket');
  });

  it('keeps a ticket under its map, even in a milestone', () => {
    const found = skillIssues(
      [
        map(1),
        issue(2, {
          parent: ref(1),
          labels: [label('wayfinder:task')],
          milestone: { title: 'M4', dueOn: null },
        }),
      ],
      DEFAULT_SKILL_LABELS,
    );
    expect(found.groups.map((group) => group.kind)).toEqual(['map']);
    expect(found.ticketKind('issue-commander-2')).toBe('map-ticket');
    expect(found.ticketKind('issue-commander-1')).toBe('map');
  });
});

describe('progress', () => {
  it('counts closed tickets of all tickets, closed as not planned among them', () => {
    const found = skillIssues(
      [
        map(1),
        issue(2, { parent: ref(1), ...closed(NOW - 9 * DAY) }),
        issue(3, { parent: ref(1), ...closed(NOW - 9 * DAY, 'not-planned') }),
        issue(4, { parent: ref(1) }),
        issue(5, { parent: ref(1) }),
      ],
      DEFAULT_SKILL_LABELS,
    );
    expect(found.groups[0]).toMatchObject({ kind: 'map', title: 'Commander v1 map', done: 2, total: 4 });
  });

  it("fills in sub-issues Commander doesn't hold from the map's sub-issue count", () => {
    // GitHub says 26 sub-issues, 15 of them closed; Commander holds four (two closed).
    const found = skillIssues(
      [
        map(1, { subIssues: { total: 26, completed: 15 } }),
        issue(2, { parent: ref(1), ...closed(NOW - 9 * DAY) }),
        issue(3, { parent: ref(1), ...closed(NOW - 9 * DAY) }),
        issue(4, { parent: ref(1) }),
        issue(5, { parent: ref(1) }),
      ],
      DEFAULT_SKILL_LABELS,
    );
    expect(found.groups[0]).toMatchObject({ done: 15, total: 26 });
  });

  it('trusts the tickets it holds over an older sub-issue count', () => {
    const found = skillIssues(
      [
        map(1, { subIssues: { total: 2, completed: 0 } }),
        issue(2, { parent: ref(1), ...closed(NOW - HOUR) }),
        issue(3, { parent: ref(1), ...closed(NOW - HOUR) }),
        issue(4, { parent: ref(1) }),
      ],
      DEFAULT_SKILL_LABELS,
    );
    expect(found.groups[0]).toMatchObject({ done: 2, total: 3 });
  });

  it("counts task-list tickets Commander doesn't hold by their tick", () => {
    const found = skillIssues(
      [map(1, { body: '- [x] #2\n- [x] #3\n- [ ] #4' }), issue(4)],
      DEFAULT_SKILL_LABELS,
    );
    expect(found.groups[0]).toMatchObject({ done: 2, total: 3 });
  });

  it("fills in a milestone's issues Commander doesn't hold from GitHub's count", () => {
    const m4 = { title: 'M4 · GitHub', dueOn: null, issues: { open: 4, closed: 7 } };
    const found = skillIssues(
      [
        issue(119, { labels: [label('ready-for-agent')], milestone: m4, ...closed(NOW - HOUR) }),
        issue(120, { labels: [label('ready-for-agent')], milestone: m4 }),
      ],
      DEFAULT_SKILL_LABELS,
    );
    expect(found.groups[0]).toMatchObject({ kind: 'milestone', done: 7, total: 11 });
  });

  it('counts open tickets with an open blocker as blocked, going by the blocker Commander holds', () => {
    const blocker = issue(116, { ...closed(NOW - HOUR) });
    const found = skillIssues(
      [
        map(1),
        blocker,
        issue(2, { parent: ref(1) }),
        // Synced while #116 was open; it has closed since.
        issue(3, { parent: ref(1), blockedBy: [{ ...ref(116), state: 'open' }] }),
        // Blocked by one Commander doesn't hold, open when last seen.
        issue(4, { parent: ref(1), blockedBy: [{ ...ref(117, OTHER), state: 'open' }] }),
        issue(5, { parent: ref(1), blockedBy: [{ ...ref(2), state: 'open' }] }),
      ],
      DEFAULT_SKILL_LABELS,
    );
    expect(found.groups[0]?.blocked).toBe(2);
  });

  it('says how many tickets opened and closed in a range', () => {
    const found = skillIssues(
      [
        map(1),
        issue(2, { parent: ref(1), createdAt: NOW - HOUR }),
        issue(3, { parent: ref(1), createdAt: NOW - 2 * HOUR }),
        issue(4, { parent: ref(1), ...closed(NOW - 3 * HOUR) }),
        issue(5, { parent: ref(1), createdAt: FROM - DAY, ...closed(FROM - HOUR) }),
      ],
      DEFAULT_SKILL_LABELS,
    );
    const group = found.groups[0];
    if (!group) throw new Error('no group');
    expect(changedIn(group, { from: FROM, to: NOW })).toEqual({ opened: 2, closed: 1 });
  });
});
