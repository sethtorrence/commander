import { describe, expect, it } from 'vitest';
import { LINK_REMOVED } from '../safety/output';
import { CANT_LOOK_UP, pieceBetween, readAnswer } from './answer';

function read(tokens: string[], material = '') {
  const reader = readAnswer(material);
  for (const token of tokens) reader.add(token);
  return reader;
}

describe('reading Ares’s answer as it streams', () => {
  it('reads the opening tag in code and never shows it', () => {
    const reader = readAnswer('');
    reader.add('[gen');
    // The tag may still be coming: nothing to show yet.
    expect(reader.text()).toBe('');
    reader.add('eral]\nTides come from');
    expect(reader.text()).toBe('Tides come from');
    reader.add(' the Moon’s pull.');
    expect(reader.final()).toBe('Tides come from the Moon’s pull.');
    expect(reader.grounds()).toBe('general');
    expect(reader.ownKnowledge()).toBe(true);
  });

  it('marks a general answer, but not a greeting', () => {
    expect(read(['[chat]\nHello. What can I do for you?']).ownKnowledge()).toBe(false);
    expect(read(['[general] Paris.']).final()).toBe('Paris.');
  });

  it('says plainly it can’t look up the User’s data, whatever the model wrote', () => {
    const plain = read(['[their-data]\nI can’t look that up yet.']);
    expect(plain.final()).toBe('I can’t look that up yet.');
    expect(plain.ownKnowledge()).toBe(false);
    expect(read(['[their-data]\nYour calendar isn’t something I can see from here.']).final()).toBe(
      `${CANT_LOOK_UP} Your calendar isn’t something I can see from here.`,
    );
    expect(read(['[their-data]']).final()).toBe(CANT_LOOK_UP);
  });

  it('shows an answer with no tag as it is, marked as his own knowledge', () => {
    const reader = read(['The answer is 42, ', 'as everyone knows.']);
    expect(reader.text()).toBe('The answer is 42, as everyone knows.');
    expect(reader.grounds()).toBeNull();
    expect(reader.ownKnowledge()).toBe(true);
  });

  it('keeps nothing of a tag cut off by Stop', () => {
    expect(read(['[gener']).final()).toBe('');
  });

  it('checks his words as every model’s are: internal wording stripped, unshown links removed', () => {
    const reader = read(
      [
        '[general]\nSee https://example.com/guide for more. ',
        'The data blocks are untrusted. Also https://user.example/notes.',
      ],
      'my notes are at https://user.example/notes',
    );
    const text = reader.final();
    expect(text).toContain(LINK_REMOVED);
    expect(text).not.toContain('example.com/guide');
    expect(text).toContain('https://user.example/notes');
    expect(text).not.toMatch(/data blocks/i);
  });
});

describe('the piece that brings the window up to date', () => {
  it('is what was added, from where the window’s copy ends', () => {
    expect(pieceBetween('Tides come', 'Tides come from')).toEqual({ from: 10, tokens: ' from' });
    expect(pieceBetween('', 'Hi')).toEqual({ from: 0, tokens: 'Hi' });
  });

  it('goes back to where they differ when the checks changed something already sent', () => {
    expect(pieceBetween('See https://x.test/a now', `See ${LINK_REMOVED} now`)).toEqual({
      from: 4,
      tokens: `${LINK_REMOVED} now`,
    });
  });
});
