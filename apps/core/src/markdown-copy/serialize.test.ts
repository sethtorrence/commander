import { describe, expect, it } from 'vitest';
import { type CopyBlock, type CopyProjects, dailyNoteMarkdown, READ_ONLY_NOTICE } from './serialize';

// Fixture tests for the Markdown copy's serializer (#53): a Daily Note's Blocks in, the file's text out.

const projects: CopyProjects = {
  code: (id) => ({ lt: 'LT', hm: 'HM', old: 'OL' })[id],
  name: (id) => ({ lt: 'Longtail', hm: 'Home', old: 'Longtail' })[id],
};

let next = 0;
// A Block; `under` is its parent's id. Positions follow the order the fixture lists them in.
function block(id: string, text: string, fields: Partial<CopyBlock> = {}): CopyBlock {
  next += 1;
  return {
    id,
    parentId: null,
    position: `a${String(next).padStart(4, '0')}`,
    text,
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

  it('writes top-level heading Blocks as headings, with their children as a tab-indented list', () => {
    const blocks = [
      block('m', '# Morning'),
      block('m1', 'Coffee', { parentId: 'm' }),
      block('m1a', 'Flat white', { parentId: 'm1' }),
      block('m1a1', 'Oat milk', { parentId: 'm1a' }),
      block('m2', 'Walk', { parentId: 'm' }),
      block('t', '## Todos'),
      block('i', '### Ideas'),
      block('i1', 'A tool shed', { parentId: 'i' }),
    ];
    expect(dailyNoteMarkdown(blocks, projects)).toBe(
      file(
        '# Morning',
        '',
        '- Coffee',
        '\t- Flat white',
        '\t\t- Oat milk',
        '- Walk',
        '',
        '## Todos',
        '',
        '### Ideas',
        '',
        '- A tool shed',
      ),
    );
  });

  it('writes other top-level Blocks as list items, nesting their children', () => {
    const blocks = [
      block('a', 'Loose thought'),
      block('a1', 'and a follow-up', { parentId: 'a' }),
      block('h', '# Evening'),
      block('h1', 'Read', { parentId: 'h' }),
      block('b', 'After the section'),
    ];
    expect(dailyNoteMarkdown(blocks, projects)).toBe(
      file(
        '- Loose thought',
        '\t- and a follow-up',
        '',
        '# Evening',
        '',
        '- Read',
        '',
        '- After the section',
      ),
    );
  });

  it('keeps a heading below the top level as it is, inside its list item', () => {
    const blocks = [block('a', 'Notes'), block('a1', '## Sub-heading', { parentId: 'a' })];
    expect(dailyNoteMarkdown(blocks, projects)).toBe(file('- Notes', '\t- ## Sub-heading'));
  });

  it('follows position, not the order the Blocks come in', () => {
    const second = block('b', 'Second');
    const first = block('a', 'First', { position: 'a0' });
    expect(dailyNoteMarkdown([second, first], projects)).toBe(file('- First', '- Second'));
  });

  it('puts a Block whose parent is missing at the top, and leaves out Blocks caught in a loop', () => {
    const blocks = [
      block('a', 'Orphan', { parentId: 'gone' }),
      block('x', 'Loop one', { parentId: 'y' }),
      block('y', 'Loop two', { parentId: 'x' }),
    ];
    expect(dailyNoteMarkdown(blocks, projects)).toBe(file('- Orphan'));
  });

  it('keeps formatting as the Markdown it is stored as', () => {
    const text = 'A **bold** and *italic* note with `code` and [a link](https://example.com/a?b=c)';
    expect(dailyNoteMarkdown([block('a', text)], projects)).toBe(file(`- ${text}`));
    expect(dailyNoteMarkdown([block('h', '# A **bold** heading')], projects)).toBe(
      file('# A **bold** heading'),
    );
  });

  it('writes Todos as checkboxes, open and ticked', () => {
    const blocks = [
      block('h', '# Todos'),
      block('t1', 'Send the deck', { parentId: 'h', todo: 'open' }),
      block('t2', 'Book the room', { parentId: 'h', todo: 'done' }),
      block('t3', 'Sub-task', { parentId: 't2', todo: 'open' }),
      block('t4', 'Top-level Todo', { todo: 'done' }),
    ];
    expect(dailyNoteMarkdown(blocks, projects)).toBe(
      file(
        '# Todos',
        '',
        '- [ ] Send the deck',
        '- [x] Book the room',
        '\t- [ ] Sub-task',
        '',
        '- [x] Top-level Todo',
      ),
    );
  });

  it('writes a Todo that looks like a heading as a checkbox item, not a heading', () => {
    expect(dailyNoteMarkdown([block('t', '# Big one', { todo: 'open' })], projects)).toBe(
      file('- [ ] # Big one'),
    );
  });

  it('writes a Block’s own Project as #LT, once, and leaves inherited Projects out', () => {
    const blocks = [
      block('h', '# Meetings', { ownProjectId: 'lt' }),
      block('a', 'Stand-up', { parentId: 'h' }),
      block('b', 'Picked from the Badge picker', { parentId: 'h', ownProjectId: 'hm' }),
      block('c', 'Typed #lt shorthand', { parentId: 'h', ownProjectId: 'lt' }),
      block('d', 'Filed by a Rule, archived Project #OL', { parentId: 'h', ownProjectId: 'old' }),
      block('e', 'Unknown Project', { parentId: 'h', ownProjectId: 'nope' }),
    ];
    expect(dailyNoteMarkdown(blocks, projects)).toBe(
      file(
        '# Meetings #LT',
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
      file('- See [[2026-10-01]] and [[Longtail]], merged: [[Longtail]], gone: [[project:nope]]'),
    );
  });

  it('writes a meeting chip as its times and title, with the notes under it', () => {
    const meetings: CopyProjects = {
      ...projects,
      meeting: (id) =>
        ({ sync: '10:00–10:30 Weekly sync with Priya', gone: '~~09:00–09:15 Standup~~ (Cancelled)' })[id],
    };
    const blocks = [
      block('m', 'Meetings'),
      block('c', '[[event:sync]]', { parentId: 'm' }),
      block('n', 'Priya owns the launch checklist', { parentId: 'c' }),
      block('x', '[[event:gone]]', { parentId: 'm' }),
      block('p', 'Prep for [[event:sync]] and [[event:unknown]]'),
    ];
    expect(dailyNoteMarkdown(blocks, meetings)).toBe(
      file(
        '- Meetings',
        '\t- 10:00–10:30 Weekly sync with Priya',
        '\t\t- Priya owns the launch checklist',
        '\t- ~~09:00–09:15 Standup~~ (Cancelled)',
        '- Prep for 10:00–10:30 Weekly sync with Priya and a meeting',
      ),
    );
  });

  it('keeps a Project name from breaking the [[ link', () => {
    const odd: CopyProjects = { code: () => 'OD', name: () => 'Q3 [draft] | #1 ^x' };
    expect(dailyNoteMarkdown([block('a', 'On [[project:od]]')], odd)).toBe(file('- On [[Q3 draft 1 x]]'));
  });

  it('embeds images from attachments/', () => {
    const name = `${'a'.repeat(64)}.png`;
    const blocks = [block('h', '# Ideas'), block('i', `![](attachments/${name})`, { parentId: 'h' })];
    expect(dailyNoteMarkdown(blocks, projects)).toBe(file('# Ideas', '', `- ![](attachments/${name})`));
  });

  it('leaves out empty Blocks, unless something written is under one', () => {
    const blocks = [
      block('h', '# Morning'),
      block('e', '', { parentId: 'h' }),
      block('s', '   ', { parentId: 'h' }),
      block('p', '', { parentId: 'h' }),
      block('p1', 'Under an empty Block', { parentId: 'p' }),
      block('t', '', { parentId: 'h', todo: 'open' }),
    ];
    expect(dailyNoteMarkdown(blocks, projects)).toBe(
      file('# Morning', '', '-', '\t- Under an empty Block', '- [ ]'),
    );
  });

  it('escapes text that Markdown would read as a list, a checkbox or a quote', () => {
    const blocks = [
      block('a', '- not a nested list'),
      block('b', '[ ] not a checkbox'),
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
        '- \\[x] nor this',
        '- 1\\. not numbered',
        '- \\> not a quote',
        '- \\+ plus',
        '- #LT on its own is a tag',
      ),
    );
  });

  it('keeps a Block’s later lines inside its list item', () => {
    const blocks = [block('a', 'Parent'), block('b', 'First line\nsecond line', { parentId: 'a' })];
    expect(dailyNoteMarkdown(blocks, projects)).toBe(file('- Parent', '\t- First line', '\t  second line'));
    expect(dailyNoteMarkdown([block('h', '# Two\nlines')], projects)).toBe(file('# Two lines'));
  });
});
