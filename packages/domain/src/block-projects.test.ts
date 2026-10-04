import { describe, expect, it } from 'vitest';
import { blockTag, inheritedFiling, isOwnFiling, replaceBlockTag, tagBeingTyped } from './block-projects';

const LT = { id: 'p-lt', code: 'LT', archived: false };
const TX = { id: 'p-tx', code: 'TX', archived: false };
const OLD = { id: 'p-old', code: 'OD', archived: true };
const projects = [LT, TX, OLD];

describe('the #LT shorthand in a Block’s text', () => {
  it('names an active Project by its code, in any case', () => {
    expect(blockTag('Planning #LT', projects)).toMatchObject({ projectId: 'p-lt', start: 9, end: 12 });
    expect(blockTag('#lt at the start', projects)).toMatchObject({ projectId: 'p-lt', start: 0, end: 3 });
    expect(blockTag('mixed #Tx case', projects)?.projectId).toBe('p-tx');
  });

  it('is `#` followed directly by letters only, standing on its own', () => {
    expect(blockTag('#LT, then more', projects)?.projectId).toBe('p-lt');
    expect(blockTag('(#LT)', projects)?.projectId).toBe('p-lt');
    expect(blockTag('# LT is a heading, not a tag', projects)).toBeNull();
    expect(blockTag('#LT2 has a digit', projects)).toBeNull();
    expect(blockTag('#LTX is a longer word', projects)).toBeNull();
    expect(blockTag('page#LT is part of a word', projects)).toBeNull();
  });

  it('stays plain text for an unknown or archived code', () => {
    expect(blockTag('#ZZ unknown', projects)).toBeNull();
    expect(blockTag('#OD archived', projects)).toBeNull();
  });

  it('takes the first known code when there are several', () => {
    expect(blockTag('#ZZ #TX #LT', projects)?.projectId).toBe('p-tx');
  });

  it('is replaced by another Project’s code, or removed with the space after it', () => {
    expect(replaceBlockTag('Planning #lt today', projects, 'TX')).toBe('Planning #TX today');
    expect(replaceBlockTag('Planning #LT today', projects, null)).toBe('Planning today');
    expect(replaceBlockTag('#LT Planning', projects, null)).toBe('Planning');
    expect(replaceBlockTag('Planning #LT', projects, null)).toBe('Planning');
    expect(replaceBlockTag('No tag here', projects, 'TX')).toBe('No tag here');
  });

  it('is offered while being typed: `#` and letters right before the caret', () => {
    expect(tagBeingTyped('Planning #l', 11)).toEqual({ query: 'l', start: 9 });
    expect(tagBeingTyped('#Lo', 3)).toEqual({ query: 'Lo', start: 0 });
    expect(tagBeingTyped('Planning #', 10)).toBeNull();
    expect(tagBeingTyped('Planning #lt more', 17)).toBeNull();
    expect(tagBeingTyped('page#lt', 7)).toBeNull();
    expect(tagBeingTyped('#lt2', 4)).toBeNull();
  });
});

describe('how a Block is filed', () => {
  it('has its own Project when the User, a Rule or Ares filed it, not when it inherits one', () => {
    expect(isOwnFiling({ projectId: 'p-lt', filedBy: 'user' })).toBe(true);
    expect(isOwnFiling({ projectId: 'p-lt', filedBy: 'ares' })).toBe(true);
    expect(isOwnFiling({ projectId: 'p-lt', filedBy: 'inherited' })).toBe(false);
    expect(isOwnFiling(null)).toBe(false);
  });

  it('inherits its parent’s Project, whichever way the parent got it; nothing at the top', () => {
    expect(inheritedFiling({ projectId: 'p-lt', filedBy: 'user' })).toEqual({
      projectId: 'p-lt',
      filedBy: 'inherited',
    });
    expect(inheritedFiling({ projectId: 'p-lt', filedBy: 'inherited' })).toEqual({
      projectId: 'p-lt',
      filedBy: 'inherited',
    });
    expect(inheritedFiling(null)).toBeNull();
  });
});
