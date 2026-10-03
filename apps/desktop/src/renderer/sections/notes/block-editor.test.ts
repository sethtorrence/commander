// @vitest-environment jsdom
import type { KeyboardEvent, MouseEvent } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { formatShortcut, imageFiles, linkClicked, renderBlockText, selectText } from './block-editor';
import { selectionIn } from './caret';

afterEach(() => {
  document.body.innerHTML = '';
});

function editor(text = '') {
  const element = document.createElement('div');
  element.contentEditable = 'true';
  element.tabIndex = 0;
  document.body.append(element);
  renderBlockText(element, text);
  return element;
}

const key = (
  key: string,
  mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {},
) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

describe('formatting shortcuts', () => {
  it('are Ctrl+B, Ctrl+I and Ctrl+E (Cmd on a Mac)', () => {
    expect(formatShortcut(key('b', { ctrlKey: true }))).toBe('**');
    expect(formatShortcut(key('i', { ctrlKey: true }))).toBe('*');
    expect(formatShortcut(key('e', { ctrlKey: true }))).toBe('`');
    expect(formatShortcut(key('B', { metaKey: true }))).toBe('**');
  });

  it('leave other keys alone', () => {
    expect(formatShortcut(key('b'))).toBeNull();
    expect(formatShortcut(key('b', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(formatShortcut(key('i', { ctrlKey: true, altKey: true }))).toBeNull();
    expect(formatShortcut(key('z', { ctrlKey: true }))).toBeNull();
  });
});

describe('rendering a Block while it is edited', () => {
  it('keeps the caret at the same place in the text when the markup changes', () => {
    const element = editor('make **bold');
    element.focus();
    selectText(element, 11);
    element.append('**'); // as if typed: the text is now marked bold
    renderBlockText(element, element.textContent ?? '');

    expect(element.querySelector('strong')?.textContent).toBe('**bold**');
    expect(selectionIn(element)).toEqual([11, 11]);
  });

  it('keeps a selection across the markup', () => {
    const element = editor('a **b** c');
    element.focus();
    selectText(element, 2, 7);
    renderBlockText(element, 'a **b** c');
    expect(selectionIn(element)).toEqual([2, 7]);
  });
});

describe('clicking a link', () => {
  const click = (element: HTMLElement, target: Element, mods: { ctrlKey?: boolean } = {}) =>
    ({
      button: 0,
      target,
      currentTarget: element,
      ctrlKey: false,
      metaKey: false,
      ...mods,
    }) as unknown as MouseEvent<HTMLElement>;

  it('opens it while the Block is not being edited', () => {
    const element = editor('see [docs](https://example.com)');
    const link = element.querySelector('[data-href]') as Element;
    expect(linkClicked(click(element, link))).toBe('https://example.com');
  });

  it('places the caret while the Block is being edited, unless Ctrl is held', () => {
    const element = editor('see [docs](https://example.com)');
    element.focus();
    const link = element.querySelector('[data-href]') as Element;
    expect(linkClicked(click(element, link))).toBeNull();
    expect(linkClicked(click(element, link, { ctrlKey: true }))).toBe('https://example.com');
  });

  it('is nothing on plain text', () => {
    const element = editor('see [docs](https://example.com)');
    expect(linkClicked(click(element, element))).toBeNull();
  });
});

describe('pasted files', () => {
  it('are taken when they are PNG, JPEG, GIF or WebP images', () => {
    const files = [
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.jpg', { type: 'image/jpeg' }),
      new File(['c'], 'c.svg', { type: 'image/svg+xml' }),
      new File(['d'], 'd.txt', { type: 'text/plain' }),
    ];
    const data = { files } as unknown as DataTransfer;
    expect(imageFiles(data).map((file) => file.name)).toEqual(['a.png', 'b.jpg']);
    expect(imageFiles(null)).toEqual([]);
  });
});
