import type { Item, Project, Rule, RuleWhen } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { fieldChoices, placements, ruleText, whenDraftOf, whenOf } from './rules';

const project = (id: string, code: string): Project => ({
  id,
  name: code,
  code,
  accent: 'blue',
  order: 0,
  archived: false,
  createdAt: 0,
});
const projects = [project('p-tl', 'TL'), project('p-tx', 'TX')];

const team = (key: string): RuleWhen => ({
  join: 'and',
  terms: [{ field: 'linear.team', op: 'is', value: `team-${key}`, label: key }],
});
const rule = (id: string, key: string, projectId = 'p-tl'): Rule => ({
  id,
  target: { kind: 'project', projectId },
  when: team(key),
  order: 0,
  createdAt: 0,
});

describe('how a Rule reads', () => {
  it('reads as its conditions, an arrow and the Badge code', () => {
    expect(ruleText(rule('a', 'ENG'), projects)).toBe('team is ENG → TL');
    expect(
      ruleText(
        {
          target: { kind: 'project', projectId: 'p-tx' },
          when: {
            join: 'and',
            terms: [
              { field: 'linear.team', op: 'is', value: 't', label: 'ENG' },
              {
                join: 'or',
                conditions: [
                  { field: 'linear.label', op: 'is', value: 'i', label: 'infra' },
                  { field: 'linear.label', op: 'is-not', value: 'p', label: 'perf' },
                ],
              },
              { field: 'linear.title', op: 'contains', value: 'login', label: 'login' },
            ],
          },
        },
        projects,
      ),
    ).toBe('team is ENG AND (label is infra OR label is not perf) AND title contains “login” → TX');
  });
});

describe('where an overlapping Rule can go', () => {
  const list = [rule('a', 'ENG'), rule('b', 'OPS', 'p-tx'), rule('c', 'WEB')];

  it('offers above and below each Rule it overlaps, as places in the list without it', () => {
    expect(placements(list, [list[0] as Rule, list[2] as Rule], projects)).toEqual([
      { position: 0, label: 'Above team is ENG → TL' },
      { position: 1, label: 'Below team is ENG → TL' },
      { position: 2, label: 'Above team is WEB → TL' },
      { position: 3, label: 'Below team is WEB → TL' },
    ]);
  });

  it('says once a place that is below one Rule and above the next', () => {
    expect(placements(list, [list[0] as Rule, list[1] as Rule], projects).map((p) => p.label)).toEqual([
      'Above team is ENG → TL',
      'Below team is ENG → TL, above team is OPS → TX',
      'Below team is OPS → TX',
    ]);
  });

  it('leaves out the Rule being edited when counting places', () => {
    expect(placements(list, [list[2] as Rule], projects, 'a')).toEqual([
      { position: 1, label: 'Above team is WEB → TL' },
      { position: 2, label: 'Below team is WEB → TL' },
    ]);
  });
});

describe('the editor’s draft', () => {
  it('becomes a Rule’s conditions only once every value is filled in', () => {
    const draft = whenDraftOf();
    expect(whenOf(draft)).toBeNull();

    draft.terms = [
      { field: 'linear.team', op: 'is', value: 'team-eng', label: 'ENG' },
      { join: 'or', conditions: [{ field: 'linear.title', op: 'contains', value: ' login ', label: '' }] },
    ];
    expect(whenOf(draft)).toEqual({
      join: 'and',
      terms: [
        { field: 'linear.team', op: 'is', value: 'team-eng', label: 'ENG' },
        {
          join: 'or',
          conditions: [{ field: 'linear.title', op: 'contains', value: 'login', label: 'login' }],
        },
      ],
    });
  });
});

describe('the values the editor offers', () => {
  const issue = (teamKey: string, labels: string[]): Item =>
    ({
      id: teamKey + labels.join(),
      kind: 'linear-issue',
      source: 'linear',
      account: 'linear:org-acme',
      title: 'x',
      detail: {
        kind: 'linear-issue',
        team: { id: `team-${teamKey}`, key: teamKey, name: teamKey },
        labels: labels.map((name) => ({ id: `label-${name}`, name, color: '#000000' })),
      },
    }) as unknown as Item;

  it('lists each value the held Items have once, by how it reads, naming Accounts', () => {
    const items = [issue('OPS', ['perf']), issue('ENG', ['infra', 'perf']), issue('ENG', [])];
    expect(fieldChoices(items, 'linear.team')).toEqual([
      { value: 'team-ENG', label: 'ENG' },
      { value: 'team-OPS', label: 'OPS' },
    ]);
    expect(fieldChoices(items, 'linear.label').map((c) => c.label)).toEqual(['infra', 'perf']);
    expect(fieldChoices(items, 'linear.workspace', new Map([['linear:org-acme', 'Acme']]))).toEqual([
      { value: 'linear:org-acme', label: 'Acme' },
    ]);
  });
});
