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

describe('an email chip', () => {
  const longtail = {
    id: 'p',
    name: 'Longtail',
    code: 'LT',
    accent: 'blue' as const,
    order: 0,
    archived: false,
    createdAt: 0,
  };
  const card = (gone: boolean) => () => ({
    text: 'Q4 <budget>',
    title: 'Q4 budget, from Dana Whitfield on 1 Oct: open its thread in the Email Section',
    project: longtail,
    email: { sender: 'Dana Whitfield', date: '1 Oct', gone },
  });

  it('is drawn as a card (Badge, sender, subject, date), its token kept as the text', () => {
    const element = editor();
    renderBlockText(element, 'Answer [[email:m-1]]', card(false));
    expect(element.textContent).toBe('Answer [[email:m-1]]');
    const chip = element.querySelector<HTMLElement>('.n-chip') as HTMLElement;
    expect(chip.dataset.chip).toBe('email');
    expect(chip.classList.contains('n-mail')).toBe(true);
    expect(chip.dataset.state).toBe('on');
    expect(chip.getAttribute('aria-label')).toBe('Email from Dana Whitfield: Q4 <budget>, 1 Oct');
    expect(chip.querySelector<HTMLElement>('.n-meet-badge')?.dataset.code).toBe('LT');
    expect(chip.querySelector<HTMLElement>('.n-mail-from')?.dataset.label).toBe('Dana Whitfield');
    expect(chip.querySelector<HTMLElement>('.n-meet-label')?.dataset.label).toBe('Q4 <budget>');
    expect(chip.querySelector<HTMLElement>('.n-meet-note')?.dataset.note).toBe('1 Oct');
  });

  it('is struck through when Commander no longer has it', () => {
    const element = editor();
    renderBlockText(element, '[[email:m-1]]', card(true));
    const chip = element.querySelector<HTMLElement>('.n-chip') as HTMLElement;
    expect(chip.dataset.state).toBe('struck');
    expect(chip.querySelector<HTMLElement>('.n-meet-note')?.dataset.note).toBe('Gone');
  });
});

describe('a meeting chip', () => {
  const meeting = (target: BlockLinkTarget) => ({
    text: '10:00–10:30 Weekly sync <with> Priya',
    title: 'Weekly sync, 10:00–10:30 on Primary: open it in the Calendar Section',
    project: {
      id: 'p',
      name: 'Longtail',
      code: 'LT',
      accent: 'blue',
      order: 0,
      archived: false,
      createdAt: 0,
    },
    meeting: {
      colour: '#33b679',
      joinUrl: target.type === 'event' ? 'https://meet.google.com/abc-defg-hij' : null,
      status: null,
      struck: false,
    },
  });

  it('is drawn as a card (calendar colour, Badge, times and title, Join), its token kept as the text', () => {
    const element = editor();
    renderBlockText(element, '[[event:e-1]]', meeting);
    expect(element.textContent).toBe('[[event:e-1]]');
    const chip = element.querySelector<HTMLElement>('.n-chip') as HTMLElement;
    expect(chip.dataset.chip).toBe('event');
    expect(chip.dataset.label).toBe('10:00–10:30 Weekly sync <with> Priya');
    expect(chip.dataset.state).toBe('on');
    expect(chip.style.getPropertyValue('--cal')).toBe('#33b679');
    expect(chip.querySelector<HTMLElement>('.n-meet-badge')?.dataset.code).toBe('LT');
    expect(chip.querySelector<HTMLElement>('.n-meet-join')?.dataset.join).toBe(
      'https://meet.google.com/abc-defg-hij',
    );
    expect(chip.querySelector('.n-meet-note')).toBeNull();
  });

  it('is struck through with what happened when cancelled', () => {
    const element = editor();
    const cancelled = (target: BlockLinkTarget) => ({
      ...meeting(target),
      meeting: { colour: '#33b679', joinUrl: null, status: 'Cancelled', struck: true },
    });
    renderBlockText(element, '[[event:e-1]]', cancelled);
    const chip = element.querySelector<HTMLElement>('.n-chip') as HTMLElement;
    expect(chip.dataset.state).toBe('struck');
    expect(chip.querySelector<HTMLElement>('.n-meet-note')?.dataset.note).toBe('Cancelled');
    expect(chip.querySelector('.n-meet-join')).toBeNull();
  });
});
