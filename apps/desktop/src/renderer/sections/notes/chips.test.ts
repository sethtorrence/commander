// @vitest-environment jsdom
import type { BlockLinkTarget } from '@commander/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { renderBlockText, selectText } from './block-editor';
import { placeCaret, selectionIn } from './caret';
import { parseBlock } from './markdown';

const label = (target: BlockLinkTarget) =>
  target.type === 'day'
    ? { text: 'Thu 1 Oct', title: 'Thursday 1 October 2026: go to its Daily Note' }
    : {
        text: 'Longtail',
        title: 'Longtail: open its Project page',
        project: {
          id: 'p',
          name: 'Longtail',
          code: 'LT',
          accent: 'blue',
          order: 0,
          archived: false,
          createdAt: 0,
        },
      };

const text = 'See **[[2026-10-01]]** on [[project:p]]!';

function editor() {
  const element = document.createElement('div');
  element.setAttribute('contenteditable', 'true');
  document.body.append(element);
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('[[ tokens in a Block’s Markdown', () => {
  it('parse as chips, inside formatting too, and nothing else does', () => {
    expect(parseBlock('[[2026-10-01]] [[Q4]] [x](https://a.test)').spans).toEqual([
      { type: 'chip', text: '[[2026-10-01]]', target: { type: 'day', day: '2026-10-01' } },
      { type: 'text', text: ' [[Q4]] ' },
      expect.objectContaining({ type: 'link', href: 'https://a.test' }),
    ]);
    expect(parseBlock('**[[2026-10-01]]**').spans[0]).toMatchObject({
      type: 'strong',
      children: [{ type: 'mark' }, { type: 'chip' }, { type: 'mark' }],
    });
  });
});

describe('a Block’s text with chips', () => {
  it('keeps its text exactly (tokens included), with each token drawn as a labelled chip', () => {
    const element = editor();
    renderBlockText(element, text, label);

    expect(element.textContent).toBe(text);
    const chips = [...element.querySelectorAll<HTMLElement>('.n-chip')];
    expect(
      chips.map((chip) => [chip.dataset.chip, chip.dataset.label, chip.getAttribute('aria-label')]),
    ).toEqual([
      ['day', 'Thu 1 Oct', 'Thu 1 Oct'],
      ['project', 'Longtail', 'Longtail'],
    ]);
    expect(chips[0]?.getAttribute('contenteditable')).toBe('false');
    expect(chips[0]?.closest('strong')).not.toBeNull();
    expect(chips[1]?.dataset.code).toBe('LT');
    expect(chips[1]?.title).toBe('Longtail: open its Project page');
  });

  it('puts the caret beside a chip, never inside it', () => {
    const element = editor();
    renderBlockText(element, text, label);
    element.focus();
    const end = 'See **[[2026-10-01]]'.length;

    placeCaret(element, end);
    expect(selectionIn(element)).toEqual([end, end]);
    expect(getSelection()?.getRangeAt(0).startContainer.parentElement?.closest('.n-chip')).toBeNull();

    // An offset inside a token goes to its end.
    placeCaret(element, 10);
    expect(selectionIn(element)).toEqual([end, end]);
    selectText(element, 10);
    expect(selectionIn(element)).toEqual([end, end]);
  });

  it('keeps the caret in place when drawn again while typing', () => {
    const element = editor();
    renderBlockText(element, text, label);
    element.focus();
    placeCaret(element, text.length);

    renderBlockText(element, text, label);

    expect(selectionIn(element)).toEqual([text.length, text.length]);
  });
});
