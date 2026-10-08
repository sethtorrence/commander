import type { BlockStyle } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import {
  type Block,
  blockNumbers,
  type Edit,
  enter,
  indent,
  insertBelow,
  joinNext,
  move,
  type Outline,
  outdent,
  outlineOf,
  removeBackward,
  removeBlock,
  setStyle,
  setText,
  startOutline,
  toggleFold,
  typeShorthand,
  unstyle,
  visibleBlocks,
} from './outline';

// Each line style's mark, as the outlines below write it (a plain line has none).
const MARKS: [string, BlockStyle][] = [
  ['### ', 'heading-3'],
  ['## ', 'heading-2'],
  ['# ', 'heading-1'],
  ['- ', 'bullet'],
  ['1. ', 'numbered'],
  ['[ ] ', 'todo'],
  ['> ', 'quote'],
];

// Outlines are written as indented lines, two spaces a level. A line starting "+ " is folded, and its
// style's mark comes next ("- " a bullet, "## " a heading, "> " a quote line). Each Block's id is its
// text with spaces removed, unless it ends in "#id".
function parse(source: string): Outline {
  const blocks: Block[] = [];
  const parents: string[] = [];
  const counts = new Map<string | null, number>();
  for (const line of source.split('\n')) {
    if (!line.trim()) continue;
    const depth = (line.length - line.trimStart().length) / 2;
    let text = line.trim();
    const folded = text.startsWith('+ ');
    if (folded) text = text.slice(2);
    const [mark, style] = MARKS.find(([mark]) => text.startsWith(mark)) ?? ['', 'plain'];
    text = text.slice(mark.length);
    const [body = '', explicit] = text.split('#');
    const id = explicit ?? body.replace(/\s/g, '');
    const parentId = depth ? (parents[depth - 1] ?? null) : null;
    const n = counts.get(parentId) ?? 0;
    counts.set(parentId, n + 1);
    blocks.push({ id, parentId, position: `a${n}`, text: body, folded, ...(mark && { style }) });
    parents[depth] = id;
    parents.length = depth + 1;
  }
  return outlineOf(blocks);
}

function print(outline: Outline): string {
  return visibleBlocks(outline, { includeFolded: true })
    .map(({ block, depth }) => {
      const mark = MARKS.find(([, style]) => style === block.style)?.[0] ?? '';
      return `${'  '.repeat(depth)}${block.folded ? '+ ' : ''}${mark}${block.text}`;
    })
    .join('\n');
}

const lines = (...rows: string[]) => rows.join('\n');

function apply(edit: Edit | null): Edit {
  if (!edit) throw new Error('Expected the edit to apply');
  return edit;
}

describe('an outline', () => {
  it('lists Blocks in outline order, leaving out the children of folded ones', () => {
    const outline = parse(lines('+ Morning', '  Slept badly', 'Evening', '  Read', '    Chapter 3'));

    expect(visibleBlocks(outline).map(({ block, depth }) => [block.id, depth])).toEqual([
      ['Morning', 0],
      ['Evening', 0],
      ['Read', 1],
      ['Chapter3', 2],
    ]);
  });

  it('numbers every Block in outline order, folded ones included', () => {
    const outline = parse(lines('+ Morning', '  Slept badly', 'Evening'));

    expect(blockNumbers(outline)).toEqual(
      new Map([
        ['Morning', '001'],
        ['Sleptbadly', '002'],
        ['Evening', '003'],
      ]),
    );
  });

  it('shows a Block whose parent is missing at the top, so nothing goes out of sight', () => {
    const outline = outlineOf([{ id: 'x', parentId: 'gone', position: 'a0', text: 'Orphan', folded: false }]);

    expect(print(outline)).toBe('Orphan');
  });

  it('starts with one empty Block', () => {
    const edit = startOutline('first');

    expect(print(edit.outline)).toBe('');
    expect(edit.changes).toMatchObject([
      { type: 'create', block: { id: 'first', parentId: null, text: '' } },
    ]);
    expect(edit.focus).toEqual({ id: 'first', offset: 0 });
  });
});

describe('Enter', () => {
  it('splits a Block at the caret into a new Block below', () => {
    const edit = apply(enter(parse('Call Dana tomorrow'), 'CallDanatomorrow', 9, 9, 'new'));

    expect(print(edit.outline)).toBe(lines('Call Dana', ' tomorrow'));
    expect(edit.changes.map((change) => change.type)).toEqual(['update', 'create']);
    expect(edit.focus).toEqual({ id: 'new', offset: 0 });
  });

  it('at the end of a Block makes an empty one below, keeping the next ones in order', () => {
    const edit = apply(enter(parse(lines('First', 'Second')), 'First', 5, 5, 'new'));

    expect(print(edit.outline)).toBe(lines('First', '', 'Second'));
    expect(edit.changes).toMatchObject([{ type: 'create', block: { id: 'new', text: '' } }]);
  });

  it('replaces a selection', () => {
    const edit = apply(enter(parse('Keep this and that'), 'Keepthisandthat', 4, 13, 'new'));

    expect(print(edit.outline)).toBe(lines('Keep', ' that'));
  });

  it('at the start of a Block makes an empty one above and stays put', () => {
    const edit = apply(enter(parse('Text'), 'Text', 0, 0, 'new'));

    expect(print(edit.outline)).toBe(lines('', 'Text'));
    expect(edit.focus).toEqual({ id: 'Text', offset: 0 });
  });

  it('on a Block with open children makes the new Block its first child', () => {
    const edit = apply(enter(parse(lines('Parent', '  Child')), 'Parent', 6, 6, 'new'));

    expect(print(edit.outline)).toBe(lines('Parent', '  ', '  Child'));
  });

  it('on a folded Block makes the new Block its next sibling', () => {
    const edit = apply(enter(parse(lines('+ Parent', '  Child', 'Next')), 'Parent', 6, 6, 'new'));

    expect(print(edit.outline)).toBe(lines('+ Parent', '  Child', '', 'Next'));
  });

  it('on a plain line makes a plain line, and after a heading too (#239)', () => {
    const plain = apply(enter(parse('Text'), 'Text', 4, 4, 'new'));
    expect(plain.changes).toMatchObject([{ type: 'create', block: { id: 'new', style: 'plain' } }]);

    const heading = apply(enter(parse(lines('## Morning', '## Evening')), 'Morning', 7, 7, 'new'));
    expect(print(heading.outline)).toBe(lines('## Morning', '', '## Evening'));
    // A heading split in two keeps its first half; the rest is a plain line.
    expect(print(apply(enter(parse('## Good morning'), 'Goodmorning', 4, 4, 'new')).outline)).toBe(
      lines('## Good', ' morning'),
    );
  });

  it('on an empty plain line makes another, wherever it is', () => {
    const edit = apply(enter(parse(lines('## Morning', '  #empty')), 'empty', 0, 0, 'new'));

    expect(print(edit.outline)).toBe(lines('## Morning', '  ', '  '));
  });
});

describe('lists (#239)', () => {
  it('go on with Enter, bullets as bullets and numbered items as numbered items', () => {
    expect(print(apply(enter(parse('- Milk'), 'Milk', 4, 4, 'new')).outline)).toBe(lines('- Milk', '- '));
    expect(print(apply(enter(parse('1. Step'), 'Step', 4, 4, 'new')).outline)).toBe(lines('1. Step', '1. '));
    // At the start of an item, the new one above is an item too.
    expect(print(apply(enter(parse('- Milk'), 'Milk', 0, 0, 'new')).outline)).toBe(lines('- ', '- Milk'));
  });

  it('take a new first item under an item with items under it, as theirs', () => {
    const edit = apply(enter(parse(lines('- Groceries', '  1. Milk')), 'Groceries', 9, 9, 'new'));

    expect(print(edit.outline)).toBe(lines('- Groceries', '  1. ', '  1. Milk'));
  });

  it('end on Enter in an empty top item, which becomes a plain line', () => {
    const edit = apply(enter(parse(lines('- Milk', '- #empty')), 'empty', 0, 0, 'new'));

    expect(print(edit.outline)).toBe(lines('- Milk', ''));
    expect(edit.changes).toMatchObject([{ type: 'update', block: { id: 'empty', style: 'plain' } }]);
    expect(edit.focus).toEqual({ id: 'empty', offset: 0 });
  });

  it('let an empty last line under an item step out of it on Enter', () => {
    const outline = parse(lines('- Groceries', '  - Milk', '  #empty', 'Next'));
    const edit = apply(enter(outline, 'empty', 0, 0, 'new'));

    expect(print(edit.outline)).toBe(lines('- Groceries', '  - Milk', '', 'Next'));
  });

  it('step out a level on Enter in an empty nested item, still an item', () => {
    const outline = parse(lines('- Groceries', '  - Milk', '  - #empty', '- Next'));
    const edit = apply(enter(outline, 'empty', 0, 0, 'new'));

    expect(print(edit.outline)).toBe(lines('- Groceries', '  - Milk', '- ', '- Next'));
    expect(edit.changes).toMatchObject([{ type: 'update', block: { id: 'empty', parentId: null } }]);
  });
});

describe('Tab and Shift+Tab', () => {
  it('indents a list item under the item above, as its last child, with its own children', () => {
    const outline = parse(lines('- One', '  - One child', '1. Two', '  - Two child'));
    const edit = apply(indent(outline, 'Two'));

    expect(print(edit.outline)).toBe(lines('- One', '  - One child', '  1. Two', '    - Two child'));
    expect(edit.changes).toMatchObject([{ type: 'update', block: { id: 'Two', parentId: 'One' } }]);
  });

  it('unfolds the item it indents under', () => {
    const edit = apply(indent(parse(lines('+ - One', '  - Hidden', '- Two')), 'Two'));

    expect(print(edit.outline)).toBe(lines('- One', '  - Hidden', '  - Two'));
    expect(edit.changes).toHaveLength(2);
  });

  it('cannot indent the first item among its siblings', () => {
    expect(indent(parse(lines('- One', '  - Child')), 'Child')).toBeNull();
    expect(indent(parse('- One'), 'One')).toBeNull();
  });

  it('does nothing to plain lines, headings, quotes and Todos, nor under one (#239)', () => {
    const outline = parse(lines('Plain', 'Also plain', '## Heading', '> Quoted', '[ ] Todo', '- Item'));
    for (const id of ['Alsoplain', 'Heading', 'Quoted', 'Todo', 'Item'])
      expect(indent(outline, id)).toBeNull();
    expect(outdent(parse(lines('- One', '  Plain under it')), 'Plainunderit')).toBeNull();
  });

  it('outdents a list item to just after the item it is under, leaving later siblings where they are', () => {
    const outline = parse(lines('- Parent', '  - A', '  - B', '    - B child', '  - C', '- Next'));
    const edit = apply(outdent(outline, 'B'));

    expect(print(edit.outline)).toBe(lines('- Parent', '  - A', '  - C', '- B', '  - B child', '- Next'));
    expect(edit.changes).toHaveLength(1);
  });

  it('cannot outdent a top-level item, nor one out from under a heading or a meeting', () => {
    expect(outdent(parse('- Top'), 'Top')).toBeNull();
    expect(outdent(parse(lines('## Heading', '  - Item')), 'Item')).toBeNull();
    expect(outdent(parse(lines('> [[event:e1]]#chip', '  - Item')), 'Item')).toBeNull();
  });
});

describe('a meeting’s quote (#239)', () => {
  const meeting = (...notes: string[]) =>
    parse(lines('## Meetings', '  > [[event:e1]]#chip', ...notes, '  > [[event:e2]]#next'));

  it('takes Enter on its chip as the first line of its notes, a quote line', () => {
    const edit = apply(enter(meeting(), 'chip', 15, 15, 'new'));

    expect(print(edit.outline)).toBe(lines('## Meetings', '  > [[event:e1]]', '    > ', '  > [[event:e2]]'));
  });

  it('goes on with Enter in its notes, bullets and all', () => {
    const quote = apply(enter(meeting('    > Budget'), 'Budget', 6, 6, 'new'));
    expect(quote.changes).toMatchObject([{ type: 'create', block: { parentId: 'chip', style: 'quote' } }]);
    const bullet = apply(enter(meeting('    - Risk'), 'Risk', 4, 4, 'new'));
    expect(bullet.changes).toMatchObject([{ type: 'create', block: { parentId: 'chip', style: 'bullet' } }]);
  });

  it('is left on Enter in an empty last line, which follows the meeting as a plain line', () => {
    const edit = apply(enter(meeting('    > Budget', '    > #empty'), 'empty', 0, 0, 'new'));

    expect(print(edit.outline)).toBe(
      lines('## Meetings', '  > [[event:e1]]', '    > Budget', '  ', '  > [[event:e2]]'),
    );
    expect(edit.changes).toMatchObject([
      { type: 'update', block: { id: 'empty', parentId: 'Meetings', style: 'plain' } },
    ]);
  });

  it('keeps an empty line in the middle of the notes, with another after it', () => {
    const edit = apply(enter(meeting('    > #empty', '    > Budget'), 'empty', 0, 0, 'new'));

    expect(edit.changes).toMatchObject([{ type: 'create', block: { parentId: 'chip', style: 'quote' } }]);
  });
});

describe('line styles (#239)', () => {
  it('come from a shorthand typed at the start of a plain line, which goes', () => {
    const cases: [string, string, string][] = [
      ['- ', 'bullet', '- Milk'],
      ['* ', 'bullet', '- Milk'],
      ['1. ', 'numbered', '1. Milk'],
      ['12. ', 'numbered', '1. Milk'],
      ['# ', 'heading-1', '# Milk'],
      ['## ', 'heading-2', '## Milk'],
      ['### ', 'heading-3', '### Milk'],
    ];
    for (const [mark, style, printed] of cases) {
      const edit = apply(typeShorthand(parse('Milk'), 'Milk', `${mark}Milk`, mark.length));
      expect(edit.changes).toMatchObject([{ type: 'update', block: { text: 'Milk', style } }]);
      expect(print(edit.outline)).toBe(printed);
      expect(edit.focus).toEqual({ id: 'Milk', offset: 0 });
    }
  });

  it('come from a shorthand in a meeting’s quote line too', () => {
    const outline = parse(lines('> [[event:e1]]#chip', '  > #note'));

    expect(apply(typeShorthand(outline, 'note', '- ', 2)).changes).toMatchObject([
      { type: 'update', block: { id: 'note', style: 'bullet', text: '' } },
    ]);
  });

  it('need the caret just after the mark, and a plain line', () => {
    expect(typeShorthand(parse('Milk'), 'Milk', '- Milk', 6)).toBeNull();
    expect(typeShorthand(parse('Milk'), 'Milk', '-Milk', 1)).toBeNull();
    expect(typeShorthand(parse('Milk'), 'Milk', '#LT Milk', 1)).toBeNull();
    expect(typeShorthand(parse('- Milk'), 'Milk', '- Milk', 2)).toBeNull();
    expect(typeShorthand(parse('## Milk'), 'Milk', '- Milk', 2)).toBeNull();
    expect(typeShorthand(parse('[[event:e1]]#chip'), 'chip', '- [[event:e1]]', 2)).toBeNull();
  });

  it('come off with Backspace at the start, leaving a plain line (a quote line in a meeting)', () => {
    for (const styled of ['- Milk', '1. Milk', '## Milk', '> Milk', '[ ] Milk']) {
      const edit = apply(unstyle(parse(styled), 'Milk'));
      expect(print(edit.outline)).toBe('Milk');
      expect(edit.focus).toEqual({ id: 'Milk', offset: 0 });
    }
    const inMeeting = parse(lines('> [[event:e1]]#chip', '  - #item'));
    expect(apply(unstyle(inMeeting, 'item')).changes).toMatchObject([
      { block: { id: 'item', style: 'quote' } },
    ]);
  });

  it('are not there to take off a plain line, a meeting’s quote line or its chip', () => {
    expect(unstyle(parse('Milk'), 'Milk')).toBeNull();
    const meeting = parse(lines('> [[event:e1]]#chip', '  > #note'));
    expect(unstyle(meeting, 'chip')).toBeNull();
    expect(unstyle(meeting, 'note')).toBeNull();
  });

  it('can be set directly, as one change', () => {
    const edit = apply(setStyle(parse('Milk'), 'Milk', 'heading-2', 4));

    expect(print(edit.outline)).toBe('## Milk');
    expect(setStyle(edit.outline, 'Milk', 'heading-2', 4)).toBeNull();
  });
});

describe('moving a Block with Alt+Shift+Up and Down', () => {
  it('swaps it with the sibling above or below, children and all', () => {
    const outline = parse(lines('One', 'Two', '  Two child', 'Three'));

    const up = apply(move(outline, 'Two', 'up'));
    expect(print(up.outline)).toBe(lines('Two', '  Two child', 'One', 'Three'));
    expect(up.changes).toHaveLength(1);

    const down = apply(move(outline, 'Two', 'down'));
    expect(print(down.outline)).toBe(lines('One', 'Three', 'Two', '  Two child'));
  });

  it('does nothing at either end of its siblings', () => {
    const outline = parse(lines('One', '  Child', 'Two'));

    expect(move(outline, 'One', 'up')).toBeNull();
    expect(move(outline, 'Two', 'down')).toBeNull();
    expect(move(outline, 'Child', 'down')).toBeNull();
  });

  it('can move again and again between the same neighbours', () => {
    let outline = parse(lines('A', 'B', 'C'));
    for (let i = 0; i < 40; i++) outline = apply(move(outline, 'B', i % 2 ? 'down' : 'up')).outline;

    expect(print(outline)).toBe(lines('A', 'B', 'C'));
  });
});

describe('Backspace at the start of a Block', () => {
  it('removes an empty Block and puts the caret at the end of the one above', () => {
    const edit = apply(removeBackward(parse(lines('Above', '#empty')), 'empty'));

    expect(print(edit.outline)).toBe('Above');
    expect(edit.changes).toEqual([{ type: 'delete', id: 'empty' }]);
    expect(edit.focus).toEqual({ id: 'Above', offset: 5 });
  });

  it('joins a Block’s text onto the one above', () => {
    const edit = apply(removeBackward(parse(lines('Call', 'Dana')), 'Dana'));

    expect(print(edit.outline)).toBe('CallDana');
    expect(edit.focus).toEqual({ id: 'Call', offset: 4 });
  });

  it('keeps the children of an empty Block, in its place', () => {
    const outline = parse(lines('Above', '#empty', '  Child one', '  Child two', 'Below'));
    const edit = apply(removeBackward(outline, 'empty'));

    expect(print(edit.outline)).toBe(lines('Above', 'Child one', 'Child two', 'Below'));
  });

  it('only moves the caret up when the Block has text and children', () => {
    const edit = apply(removeBackward(parse(lines('Above', 'Parent', '  Child')), 'Parent'));

    expect(edit.changes).toEqual([]);
    expect(edit.focus).toEqual({ id: 'Above', offset: 5 });
  });

  it('joins onto the Block shown above, which may be a folded one or a parent', () => {
    expect(print(apply(removeBackward(parse(lines('+ Folded', '  Hidden', 'Next')), 'Next')).outline)).toBe(
      lines('+ FoldedNext', '  Hidden'),
    );
    expect(print(apply(removeBackward(parse(lines('Parent', '  #empty')), 'empty')).outline)).toBe('Parent');
  });

  it('does nothing on the first Block', () => {
    expect(removeBackward(parse(lines('#empty', 'Next')), 'empty')).toBeNull();
  });
});

describe('Delete at the end of a Block', () => {
  it('joins the next Block onto it', () => {
    const edit = apply(joinNext(parse(lines('Call', 'Dana', 'Later')), 'Call'));

    expect(print(edit.outline)).toBe(lines('CallDana', 'Later'));
    expect(edit.focus).toEqual({ id: 'Call', offset: 4 });
  });

  it('leaves a next Block with children alone, and does nothing on the last Block', () => {
    expect(joinNext(parse(lines('One', 'Two', '  Child')), 'One')).toBeNull();
    expect(joinNext(parse('Last'), 'Last')).toBeNull();
  });
});

describe('folding', () => {
  it('folds and unfolds a Block with children', () => {
    const folded = apply(toggleFold(parse(lines('Parent', '  Child')), 'Parent'));
    expect(print(folded.outline)).toBe(lines('+ Parent', '  Child'));
    expect(visibleBlocks(folded.outline).map(({ block }) => block.id)).toEqual(['Parent']);

    const unfolded = apply(toggleFold(folded.outline, 'Parent'));
    expect(print(unfolded.outline)).toBe(lines('Parent', '  Child'));
  });

  it('does nothing to a Block without children', () => {
    expect(toggleFold(parse('Alone'), 'Alone')).toBeNull();
  });
});

describe('typing', () => {
  it('changes a Block’s text', () => {
    const edit = apply(setText(parse('Draft'), 'Draft', 'Final'));

    expect(print(edit.outline)).toBe('Final');
    expect(edit.changes).toMatchObject([{ type: 'update', block: { id: 'Draft', text: 'Final' } }]);
  });

  it('records nothing when the text is the same', () => {
    expect(setText(parse('Same'), 'Same', 'Same')).toBeNull();
  });
});

describe('putting a Block below another (a pasted image)', () => {
  it('adds a Block holding the text just below, with the caret on it', () => {
    const edit = apply(insertBelow(parse(lines('Above', 'Below')), 'Above', 'Image', 'new'));

    expect(print(edit.outline)).toBe(lines('Above', 'Image', 'Below'));
    expect(edit.changes).toMatchObject([{ type: 'create', block: { id: 'new', text: 'Image' } }]);
    expect(edit.focus).toEqual({ id: 'new', offset: 5 });
  });

  it('puts it first under a Block with open children, as Enter would', () => {
    const edit = apply(insertBelow(parse(lines('Parent', '  Child')), 'Parent', 'Image', 'new'));
    expect(print(edit.outline)).toBe(lines('Parent', '  Image', '  Child'));
  });

  it('fills an empty Block instead', () => {
    const edit = apply(insertBelow(parse(lines('Above', '#empty')), 'empty', 'Image', 'new'));

    expect(print(edit.outline)).toBe(lines('Above', 'Image'));
    expect(edit.changes).toMatchObject([{ type: 'update', block: { id: 'empty', text: 'Image' } }]);
    expect(edit.focus).toEqual({ id: 'empty', offset: 5 });
  });
});

describe('removing a Block outright (an image Block)', () => {
  it('deletes it whatever its text, and puts the caret at the end of the Block above', () => {
    const edit = apply(removeBlock(parse(lines('Above', 'Image', 'Below')), 'Image'));

    expect(print(edit.outline)).toBe(lines('Above', 'Below'));
    expect(edit.changes).toEqual([{ type: 'delete', id: 'Image' }]);
    expect(edit.focus).toEqual({ id: 'Above', offset: 5 });
  });

  it('keeps its children, in its place', () => {
    const edit = apply(removeBlock(parse(lines('Above', 'Image', '  Child', 'Below')), 'Image'));
    expect(print(edit.outline)).toBe(lines('Above', 'Child', 'Below'));
  });

  it('puts the caret at the start of the Block below when it was first, or nowhere when it was alone', () => {
    expect(apply(removeBlock(parse(lines('Image', 'Below')), 'Image')).focus).toEqual({
      id: 'Below',
      offset: 0,
    });
    const alone = apply(removeBlock(parse('Image'), 'Image'));
    expect(print(alone.outline)).toBe('');
    expect(alone.focus).toBeUndefined();
  });
});
