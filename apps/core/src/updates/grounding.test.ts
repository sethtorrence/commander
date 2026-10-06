import { describe, expect, it } from 'vitest';
import { checkGrounded } from './grounding';

// What Ares was handed for one line: Commander's facts, and each Item in its own block.
const handed = [
  'Kind: Linear issues off your list. Count: 2. All reassigned.',
  'Item: ENG-418 “Throttle bursts on /sync”. Source: Linear. What happened: ENG-418 was reassigned to Priya Patel.',
  'Item: OPS-12 “Rotate the staging certificates”. Source: Linear. What happened: OPS-12 was reassigned to Lee Chen on 23 Sep.',
  'Plain sentence: 2 of your Linear issues were reassigned, so they’re off your Todos: ENG-418 and OPS-12. Nothing to do, unless one should still be yours.',
].join('\n');

const check = (text: string, mustName: string[] = ['2', 'two']) => checkGrounded(text, handed, { mustName });

describe('a composed line is kept only if it rests on what Ares was handed', () => {
  it('keeps a line whose names, numbers, dates and titles all came from the blocks', () => {
    expect(
      check(
        'Two of your Linear issues went to other people, so they’re off your Todos: ENG-418 to Priya Patel and OPS-12 to Lee Chen. Nothing to do unless one should still be yours.',
      ),
    ).toEqual({ ok: true });
    expect(check('OPS-12 “Rotate the staging certificates” went to Lee Chen on 23 Sep.', ['OPS-12'])).toEqual(
      {
        ok: true,
      },
    );
  });

  it('drops a line that cites an Item it wasn’t given', () => {
    expect(check('2 issues were reassigned: ENG-418 and ENG-999.')).toMatchObject({ ok: false });
    expect(check('2 issues left your list, including “Migrate the billing database”.')).toMatchObject({
      ok: false,
    });
  });

  it('drops a line with a wrong number or count', () => {
    expect(check('3 of your Linear issues were reassigned.', ['3'])).toMatchObject({ ok: false });
    expect(check('Three of your Linear issues were reassigned.', ['three'])).toMatchObject({ ok: false });
    expect(check('2 issues were reassigned 5 days ago.')).toMatchObject({ ok: false });
  });

  it('drops a line with a date or a day it wasn’t given', () => {
    expect(check('2 issues were reassigned on 24 Sep.')).toMatchObject({ ok: false });
    expect(check('2 issues were reassigned on Monday.')).toMatchObject({ ok: false });
    expect(check('2 issues were reassigned yesterday.')).toMatchObject({ ok: false });
  });

  it('a name it was given may be possessive', () => {
    expect(check('OPS-12 is now Lee Chen’s; nothing to do.', ['OPS-12'])).toEqual({ ok: true });
  });

  it('drops a line naming someone who isn’t in the blocks', () => {
    expect(check('2 issues were reassigned; Omar Haddad took them.')).toMatchObject({ ok: false });
    expect(check('Omar took 2 of your issues.')).toMatchObject({ ok: false });
  });

  it('allows Commander’s own words and ordinary sentence openings', () => {
    expect(
      check('Nothing to do: 2 issues left your Todos in Linear. Open each from the Update, or Dismiss this.'),
    ).toEqual({ ok: true });
  });

  it('drops a line that doesn’t name what it is about', () => {
    expect(check('Some of your issues were reassigned. Nothing to do.')).toMatchObject({ ok: false });
    expect(check('It went to Priya Patel.', ['ENG-418', 'Throttle bursts on /sync'])).toMatchObject({
      ok: false,
    });
  });

  it('drops a line too long to be one or two short sentences', () => {
    const long = `2 issues were reassigned. ${'Nothing to do. '.repeat(30)}`;
    expect(check(long)).toMatchObject({ ok: false });
  });
});
