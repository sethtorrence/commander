import { describe, expect, it } from 'vitest';
import { hasLineStyle, inMeeting, listNumbers, plainStyleUnder, shorthandIn } from './line-styles';
import { type Block, outlineOf, treeOf } from './outline';

// Line styles (#239): the rules the outliner and the rows read.

let position = 0;
const block = (id: string, fields: Partial<Block> = {}): Block => ({
  id,
  parentId: null,
  position: `a${position++}`,
  text: id,
  folded: false,
  ...fields,
});

describe('shorthands', () => {
  it('are read at the very start of a line', () => {
    expect(shorthandIn('- Milk')).toEqual({ style: 'bullet', length: 2 });
    expect(shorthandIn('* Milk')).toEqual({ style: 'bullet', length: 2 });
    expect(shorthandIn('3. Milk')).toEqual({ style: 'numbered', length: 3 });
    expect(shorthandIn('# Milk')).toEqual({ style: 'heading-1', length: 2 });
    expect(shorthandIn('## Milk')).toEqual({ style: 'heading-2', length: 3 });
    expect(shorthandIn('### Milk')).toEqual({ style: 'heading-3', length: 4 });
  });

  it('are not a Project code, a fourth heading level or a mark later in the line', () => {
    for (const text of ['#LT Milk', '#### Milk', 'Milk - eggs', '-Milk', '1.Milk', '[ ] Milk'])
      expect(shorthandIn(text)).toBeNull();
  });
});

describe('numbered items', () => {
  it('count up along a run of them, and start again after anything else', () => {
    const outline = outlineOf([
      block('one', { style: 'numbered' }),
      block('two', { style: 'numbered' }),
      block('under', { style: 'numbered', parentId: 'two' }),
      block('plain'),
      block('again', { style: 'numbered' }),
      block('bullet', { style: 'bullet' }),
    ]);

    expect(listNumbers(treeOf(outline))).toEqual(
      new Map([
        ['one', 1],
        ['two', 2],
        ['under', 1],
        ['again', 1],
      ]),
    );
  });
});

describe('a meeting’s quote', () => {
  const outline = outlineOf([
    block('meetings', { style: 'heading-2' }),
    block('chip', { parentId: 'meetings', text: '[[event:e1]]', style: 'quote' }),
    block('note', { parentId: 'chip', style: 'quote' }),
    block('deeper', { parentId: 'note', style: 'bullet' }),
    block('after', { parentId: 'meetings' }),
  ]);

  it('holds the chip and every line under it', () => {
    expect(['meetings', 'chip', 'note', 'deeper', 'after'].map((id) => inMeeting(outline, id))).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
  });

  it('makes a plain line there a quote line, with no style to take off', () => {
    expect(plainStyleUnder(outline, 'chip')).toBe('quote');
    expect(plainStyleUnder(outline, 'meetings')).toBe('plain');
    expect(plainStyleUnder(outline, null)).toBe('plain');
    const line = (id: string) => outline.get(id) as Block;
    expect(hasLineStyle(outline, line('note'))).toBe(false);
    expect(hasLineStyle(outline, line('chip'))).toBe(false);
    expect(hasLineStyle(outline, line('deeper'))).toBe(true);
    expect(hasLineStyle(outline, line('meetings'))).toBe(true);
    expect(hasLineStyle(outline, line('after'))).toBe(false);
  });
});
