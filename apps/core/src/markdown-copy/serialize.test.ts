import { describe, expect, it } from 'vitest';
import { type CopyBlock, type CopyProjects, dailyNoteMarkdown, READ_ONLY_NOTICE } from './serialize';

// Fixture tests for the Markdown copy's serializer (#53): a Daily Note's Blocks in, the file's text out.

const projects: CopyProjects = {
  code: (id) => ({ lt: 'LT', hm: 'HM', old: 'OL' })[id],
  name: (id) => ({ lt: 'Longtail', hm: 'Home', old: 'Longtail' })[id],
};

let next = 0;
// A Block, a plain line unless given a style; `parentId` is its parent's id. Positions follow the
// order the fixture lists them in.
function block(id: string, text: string, fields: Partial<CopyBlock> = {}): CopyBlock {
  next += 1;
  return {
    id,
    parentId: null,
    position: `a${String(next).padStart(4, '0')}`,
    text,
    style: 'plain',
    ownProjectId: null,
    todo: null,
    ...fields,
  };
}

const file = (...lines: string[]) => `${[READ_ONLY_NOTICE, '', ...lines].join('\n')}\n`;

describe('the Markdown copy of a Daily Note', () => {
  it('starts with the read-only notice, even with nothing written', () => {
    expect(READ_ONLY_NOTICE).toBe(
      '<!-- Read-only copy written by Commander. Edits here are overwritten. -->',
    );
    expect(dailyNoteMarkdown([], projects)).toBe(`${READ_ONLY_NOTICE}\n`);
  });

  it('writes each line style as Markdown (#239)', () => {
    const blocks = [
      block('h1', 'Big', { style: 'heading-1' }),
      block('h2', 'Morning', { style: 'heading-2' }),
      block('p1', 'A plain line'),
      block('p2', 'Another, its own paragraph'),
      block('b1', 'A bullet', { style: 'bullet' }),
      block('b2', 'and the next', { style: 'bullet' }),
      block('h3', 'Small', { style: 'heading-3' }),
      block('n1', 'First', { style: 'numbered' }),
      block('n2', 'Second', { style: 'numbered' }),
      block('t1', 'Send the deck', { style: 'todo', todo: 'open' }),
      block('t2', 'Book the room', { style: 'todo', todo: 'done' }),
      block('q', 'Quoted', { style: 'quote' }),
    ];
    expect(dailyNoteMarkdown(blocks, projects)).toBe(
      file(
        '# Big',
        '',
        '## Morning',
        '',
        'A plain line',
        '',
        'Another, its own paragraph',
        '',
        '- A bullet',
        '- and the next',
        '',
        '### Small',
        '',
        '1. First',
        '2. Second',
        '- [ ] Send the deck',
        '- [x] Book the room',
        '',
        '> Quoted',
      ),
    );
  });

  it('nests list items by tabs, and numbers each run of numbered items from 1', () => {
    const blocks = [
      block('a', 'Groceries', { style: 'bullet' }),
      block('a1', 'Milk', { style: 'bullet', parentId: 'a' }),
      block('a1a', 'Oat', { style: 'numbered', parentId: 'a1' }),
      block('a1b', 'Whole', { style: 'numbered', parentId: 'a1' }),
      block('a2', 'Bread', { style: 'bullet', parentId: 'a' }),
      block('b', 'Steps', { style: 'numbered' }),
      block('c', 'Then', { style: 'numbered' }),
      block('p', 'A line between'),
      block('d', 'Starts again', { style: 'numbered' }),
    ];
    expect(dailyNoteMarkdown(blocks, projects)).toBe(
      file(
        '- Groceries',
        '\t- Milk',
        '\t\t1. Oat',
        '\t\t2. Whole',
        '\t- Bread',
        '1. Steps',
        '2. Then',
        '',
        'A line between',
        '',
        '1. Starts again',
      ),
    );
  });

  it('writes the lines under a heading after it, not as its list', () => {
    const blocks = [
      block('m', 'Morning', { style: 'heading-2' }),
      block('m1', 'Coffee', { parentId: 'm' }),
      block('m2', 'Walk', { parentId: 'm', style: 'bullet' }),
      block('e', 'Evening', { style: 'heading-2' }),
    ];
    expect(dailyNoteMarkdown(blocks, projects)).toBe(
      file('## Morning', '', 'Coffee', '', '- Walk', '', '## Evening'),
    );
  });

  it('writes a meeting chip as its times and title, quoted with the notes under it', () => {
    const meetings: CopyProjects = {
      ...projects,
      meeting: (id) =>
        ({ sync: '10:00–10:30 Weekly sync with Priya', gone: '~~09:00–09:15 Standup~~ (Cancelled)' })[id],
    };
    const blocks = [
      block('m', 'Meetings', { style: 'heading-2' }),
      block('c', '[[event:sync]]', { parentId: 'm', style: 'quote' }),
      block('n', 'Priya owns the launch checklist', { parentId: 'c', style: 'quote' }),
      block('n2', 'Budget is fine', { parentId: 'c', style: 'quote' }),
      block('l', 'Risks', { parentId: 'c', style: 'bullet' }),
      block('l1', 'Hiring', { parentId: 'l', style: 'bullet' }),
      block('t', 'Send the deck', { parentId: 'c', style: 'todo', todo: 'open' }),
      block('x', '[[event:gone]]', { parentId: 'm', style: 'quote' }),
      block('p', 'Prep for [[event:sync]] and [[event:unknown]]'),
    ];
    expect(dailyNoteMarkdown(blocks, meetings)).toBe(
      file(
        '## Meetings',
        '',
        '> 10:00–10:30 Weekly sync with Priya',
        '>',
        '> Priya owns the launch checklist',
        '>',
        '> Budget is fine',
        '>',
        '> - Risks',
        '> \t- Hiring',
        '> - [ ] Send the deck',
        '>',
        '> ~~09:00–09:15 Standup~~ (Cancelled)',
        '',
        'Prep for 10:00–10:30 Weekly sync with Priya and a meeting',
      ),
    );
  });

  it('quotes a chip and its notes from before line styles too', () => {
    const meetings: CopyProjects = { ...projects, meeting: () => '10:00–10:30 Weekly sync' };
    const blocks = [
      block('m', 'Meetings'),
      block('c', '[[event:sync]]', { parentId: 'm' }),
      block('n', 'A note', { parentId: 'c' }),
    ];
    expect(dailyNoteMarkdown(blocks, meetings)).toBe(
      file('Meetings', '', '> 10:00–10:30 Weekly sync', '>', '> A note'),
    );
  });

  it('carries on a list item with the lines under it from before line styles', () => {
    const blocks = [
      block('a', 'Loose thought', { style: 'bullet' }),
      block('a1', 'and a follow-up', { parentId: 'a' }),
      block('b', 'Plain'),
      block('b1', 'under plain', { parentId: 'b' }),
    ];
    expect(dailyNoteMarkdown(blocks, projects)).toBe(
      file('- Loose thought', '\tand a follow-up', '', 'Plain', '', 'under plain'),
    );
  });

  it('follows position, not the order the Blocks come in', () => {
    const second = block('b', 'Second', { style: 'bullet' });
    const first = block('a', 'First', { position: 'a0', style: 'bullet' });
    expect(dailyNoteMarkdown([second, first], projects)).toBe(file('- First', '- Second'));
  });

  it('puts a Block whose parent is missing at the top, and leaves out Blocks caught in a loop', () => {
    const blocks = [
      block('a', 'Orphan', { parentId: 'gone' }),
      block('x', 'Loop one', { parentId: 'y' }),
      block('y', 'Loop two', { parentId: 'x' }),
    ];
    expect(dailyNoteMarkdown(blocks, projects)).toBe(file('Orphan'));
  });

  it('keeps formatting as the Markdown it is stored as', () => {
    const text = 'A **bold** and *italic* note with `code` and [a link](https://example.com/a?b=c)';
    expect(dailyNoteMarkdown([block('a', text)], projects)).toBe(file(text));
    expect(dailyNoteMarkdown([block('h', 'A **bold** heading', { style: 'heading-1' })], projects)).toBe(
      file('# A **bold** heading'),
    );
    // A heading typed into the text before line styles stays one.
    expect(dailyNoteMarkdown([block('h', '# Old heading')], projects)).toBe(file('# Old heading'));
  });

  it('writes a Block with a Todo as a checkbox, whatever its style', () => {
    const blocks = [
      block('t', 'Big one', { style: 'heading-1', todo: 'open' }),
      block('a', 'Ares added a Todo for it', { todo: 'done' }),
      block('g', 'Its Todo was deleted', { style: 'todo' }),
    ];
    expect(dailyNoteMarkdown(blocks, projects)).toBe(
      file('- [ ] Big one', '- [x] Ares added a Todo for it', '', 'Its Todo was deleted'),
    );
  });

  it('writes a Block’s own Project as #LT, once, and leaves inherited Projects out', () => {
    const blocks = [
      block('h', 'Meetings', { style: 'heading-2', ownProjectId: 'lt' }),
      block('a', 'Stand-up', { parentId: 'h', style: 'bullet' }),
      block('b', 'Picked from the Badge picker', { parentId: 'h', style: 'bullet', ownProjectId: 'hm' }),
      block('c', 'Typed #lt shorthand', { parentId: 'h', style: 'bullet', ownProjectId: 'lt' }),
      block('d', 'Filed by a Rule, archived Project #OL', {
        parentId: 'h',
        style: 'bullet',
        ownProjectId: 'old',
      }),
      block('e', 'Unknown Project', { parentId: 'h', style: 'bullet', ownProjectId: 'nope' }),
    ];
    expect(dailyNoteMarkdown(blocks, projects)).toBe(
      file(
        '## Meetings #LT',
        '',
        '- Stand-up',
        '- Picked from the Badge picker #HM',
        '- Typed #lt shorthand',
        '- Filed by a Rule, archived Project #OL',
        '- Unknown Project',
      ),
    );
  });

  it('writes [[ links as [[YYYY-MM-DD]] for days and [[Project name]] for Projects', () => {
    const text = 'See [[2026-10-01]] and [[project:lt]], merged: [[project:old]], gone: [[project:nope]]';
    expect(dailyNoteMarkdown([block('a', text)], projects)).toBe(
      file('See [[2026-10-01]] and [[Longtail]], merged: [[Longtail]], gone: [[project:nope]]'),
    );
  });

  it('writes an email link as its sender and subject', () => {
    const emails: CopyProjects = {
      ...projects,
      email: (id) => ({ q4: 'Email from Dana Whitfield: Q4 budget' })[id],
    };
    const blocks = [block('a', 'Answer [[email:q4]] and [[email:unknown]]')];
    expect(dailyNoteMarkdown(blocks, emails)).toBe(
      file('Answer Email from Dana Whitfield: Q4 budget and an email'),
    );
  });

  it('keeps a Project name from breaking the [[ link', () => {
    const odd: CopyProjects = { code: () => 'OD', name: () => 'Q3 [draft] | #1 ^x' };
    expect(dailyNoteMarkdown([block('a', 'On [[project:od]]')], odd)).toBe(file('On [[Q3 draft 1 x]]'));
  });

  it('embeds images from attachments/', () => {
    const name = `${'a'.repeat(64)}.png`;
    const blocks = [
      block('h', 'Ideas', { style: 'heading-2' }),
      block('i', `![](attachments/${name})`, { parentId: 'h' }),
    ];
    expect(dailyNoteMarkdown(blocks, projects)).toBe(file('## Ideas', '', `![](attachments/${name})`));
  });

  it('leaves out empty Blocks, unless something written is under one', () => {
    const blocks = [
      block('h', 'Morning', { style: 'heading-2' }),
      block('e', '', { parentId: 'h' }),
      block('s', '   ', { parentId: 'h' }),
      block('p', '', { parentId: 'h', style: 'bullet' }),
      block('p1', 'Under an empty bullet', { parentId: 'p', style: 'bullet' }),
      block('q', '', { parentId: 'h' }),
      block('q1', 'Under an empty line', { parentId: 'q' }),
      block('t', '', { parentId: 'h', style: 'todo', todo: 'open' }),
    ];
    expect(dailyNoteMarkdown(blocks, projects)).toBe(
      file('## Morning', '', '-', '\t- Under an empty bullet', '', 'Under an empty line', '', '- [ ]'),
    );
  });

  it('escapes text that Markdown would read as a list, a checkbox or a quote', () => {
    const blocks = [
      block('a', '- not a nested list', { style: 'bullet' }),
      block('b', '[ ] not a checkbox', { style: 'bullet' }),
      block('c', '[x] nor this'),
      block('d', '1. not numbered'),
      block('e', '> not a quote'),
      block('f', '+ plus'),
      block('g', '#LT on its own is a tag'),
    ];
    expect(dailyNoteMarkdown(blocks, projects)).toBe(
      file(
        '- \\- not a nested list',
        '- \\[ ] not a checkbox',
        '',
        '\\[x] nor this',
        '',
        '1\\. not numbered',
        '',
        '\\> not a quote',
        '',
        '\\+ plus',
        '',
        '#LT on its own is a tag',
      ),
    );
  });

  it('keeps a Block’s later lines with it', () => {
    const blocks = [
      block('a', 'Parent', { style: 'bullet' }),
      block('b', 'First line\nsecond line', { parentId: 'a', style: 'bullet' }),
    ];
    expect(dailyNoteMarkdown(blocks, projects)).toBe(file('- Parent', '\t- First line', '\t  second line'));
    expect(dailyNoteMarkdown([block('p', 'One\nTwo')], projects)).toBe(file('One', 'Two'));
    expect(dailyNoteMarkdown([block('h', 'Two\nlines', { style: 'heading-1' })], projects)).toBe(
      file('# Two lines'),
    );
  });
});
