import type { ItemRef } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { goneNote, kindTag, linkLabel, sectionFor } from './links';

const ref = (fields: Partial<ItemRef>): ItemRef => ({
  id: 'i',
  kind: 'todo',
  title: 'A Todo',
  source: null,
  deletedAt: null,
  ...fields,
});

describe('naming a Link from where the Todo stands', () => {
  it.each([
    ['made-from', false, 'Made from'],
    ['made-from', true, 'Made into'],
    ['refers-to', false, 'Refers to'],
    ['refers-to', true, 'Mentioned in'],
    ['finishes', false, 'Finishes'],
    ['finishes', true, 'Finished by'],
    ['about', false, 'About'],
    ['about', true, 'Subject of'],
    ['caused-by', false, 'Caused by'],
    ['caused-by', true, 'Led to'],
  ] as const)('%s, backlink %s: %s', (type, backlink, expected) => {
    expect(linkLabel({ type, backlink, other: ref({}) })).toBe(expected);
  });
});

describe('the Item at the other end', () => {
  it('is tagged with a short code for its kind', () => {
    expect(kindTag('email')).toBe('EML');
    expect(kindTag('todo')).toBe('TDO');
    expect(kindTag('linear-issue')).toBe('LIN');
    expect(kindTag('pull-request')).toBe('GH');
    expect(kindTag('block')).toBe('DN');
  });

  it('opens in the Section that holds its kind', () => {
    expect(sectionFor('todo')).toBe('todos');
    expect(sectionFor('email')).toBe('email');
    expect(sectionFor('event')).toBe('calendar');
    expect(sectionFor('linear-issue')).toBe('linear');
    expect(sectionFor('review-request')).toBe('github');
    expect(sectionFor('block')).toBe('notes');
    expect(sectionFor('chat')).toBe('teams');
    expect(sectionFor('channel-post')).toBe('teams');
    expect(sectionFor('project')).toBeNull();
  });

  it('says where it was deleted, if it was', () => {
    expect(goneNote(ref({}))).toBeNull();
    expect(goneNote(ref({ deletedAt: 5 }))).toBe('deleted');
    expect(goneNote(ref({ kind: 'email', source: 'gmail', deletedAt: 5 }))).toBe('deleted in Gmail');
  });
});
