import type { Project } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { chipLabel, insertLink, linkQueryAt, removeLinkAt, splitLinks } from './block-text';

const P = '0b6c5f7e-2f9a-4b8e-9d1c-3a4b5c6d7e8f';
const LT = `[[project:${P}]]`;
const longtail: Project = {
  id: P,
  name: 'Longtail',
  code: 'LT',
  accent: 'blue',
  order: 0,
  archived: false,
  createdAt: 0,
};

describe('the [[ being typed', () => {
  it('is found from the [[ to the caret', () => {
    expect(linkQueryAt('Call [[thu', 10)).toEqual({ start: 5, query: 'thu' });
    expect(linkQueryAt('[[', 2)).toEqual({ start: 0, query: '' });
    expect(linkQueryAt('a [[long tail', 13)).toEqual({ start: 2, query: 'long tail' });
  });

  it('is not there without a [[, after a finished token, or across brackets', () => {
    expect(linkQueryAt('Call thu', 8)).toBeNull();
    expect(linkQueryAt('[[2026-10-01]] and', 18)).toBeNull();
    expect(linkQueryAt('[[2026-10-01]]', 14)).toBeNull();
    expect(linkQueryAt('[[a]b', 5)).toBeNull();
    expect(linkQueryAt('[[thu', 2)).toEqual({ start: 0, query: '' });
  });
});

describe('choosing a target', () => {
  it('puts the token where the [[ and the query were, and the caret after it', () => {
    expect(
      insertLink('Call [[thu about it', { start: 5, query: 'thu' }, { type: 'day', day: '2026-10-01' }),
    ).toEqual({
      text: 'Call [[2026-10-01]] about it',
      caret: 19,
    });
  });
});

describe('deleting a chip', () => {
  const text = `See ${LT} today`;
  const end = 4 + LT.length;

  it('takes the whole token with Backspace just after it, or Delete just before it', () => {
    expect(removeLinkAt(text, end, 'backward')).toEqual({ text: 'See  today', caret: 4 });
    expect(removeLinkAt(text, 4, 'forward')).toEqual({ text: 'See  today', caret: 4 });
  });

  it('leaves the text alone anywhere else', () => {
    expect(removeLinkAt(text, 3, 'backward')).toBeNull();
    expect(removeLinkAt(text, end, 'forward')).toBeNull();
  });
});

describe('a Block’s text in parts', () => {
  it('splits into text and links', () => {
    expect(splitLinks(`a [[2026-10-01]]${LT}b`)).toEqual([
      { text: 'a ' },
      { text: '[[2026-10-01]]', target: { type: 'day', day: '2026-10-01' } },
      { text: LT, target: { type: 'project', projectId: P } },
      { text: 'b' },
    ]);
    expect(splitLinks('')).toEqual([]);
  });
});

describe('a chip’s label', () => {
  const context = { today: '2026-10-03', projectById: (id: string) => (id === P ? longtail : undefined) };

  it('names a day as it reads, and says where it goes', () => {
    expect(chipLabel({ type: 'day', day: '2026-10-01' }, context)).toEqual({
      text: 'Thu 1 Oct',
      title: 'Thursday 1 October 2026: go to its Daily Note',
    });
  });

  it('names a Project with its Badge, or says it is unknown', () => {
    expect(chipLabel({ type: 'project', projectId: P }, context)).toEqual({
      text: 'Longtail',
      title: 'Longtail: open its Project page',
      project: longtail,
    });
    expect(chipLabel({ type: 'project', projectId: 'gone' }, context)).toEqual({
      text: 'Unknown Project',
      title: 'This Project no longer exists',
    });
  });
});
