// @vitest-environment jsdom
import type { ComposeBody } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { readEditor, writeEditor } from './rich-text';

// The composer's editor and its model (#138): what it holds is read into the model, and the model drawn
// back with only the elements it allows, built one by one.

const editor = (html = '') => {
  const root = document.createElement('div');
  // Test input only: how Chromium's contenteditable leaves what was typed.
  root.innerHTML = html;
  return root;
};

const body: ComposeBody = [
  { type: 'paragraph', runs: [{ text: 'Hi ' }, { text: 'Dana', bold: true }, { text: ',' }] },
  { type: 'paragraph', runs: [] },
  {
    type: 'paragraph',
    runs: [
      { text: 'See ', italic: true },
      { text: 'the plan', href: 'https://acme.test/p' },
    ],
  },
  { type: 'list', ordered: true, items: [[{ text: 'one' }], [{ text: 'two', bold: true }]] },
];

describe('the composer’s editor', () => {
  it('draws the model and reads it back unchanged', () => {
    const root = editor();
    writeEditor(root, body);
    expect(root.innerHTML).toBe(
      '<div>Hi <b>Dana</b>,</div><div><br></div><div><i>See </i><a href="https://acme.test/p" rel="noreferrer noopener" target="_blank">the plan</a></div><ol><li>one</li><li><b>two</b></li></ol>',
    );
    expect(readEditor(root)).toEqual(body);
  });

  it('reads what typing leaves: a first line of bare text, then a <div> a line', () => {
    expect(
      readEditor(editor('Hello<div>Second <strong>bold</strong></div><div><br></div><ul><li>Item</li></ul>')),
    ).toEqual([
      { type: 'paragraph', runs: [{ text: 'Hello' }] },
      { type: 'paragraph', runs: [{ text: 'Second ' }, { text: 'bold', bold: true }] },
      { type: 'paragraph', runs: [] },
      { type: 'list', ordered: false, items: [[{ text: 'Item' }]] },
    ]);
  });

  it('keeps no link that isn’t to a web or mail address, nor anything else it can’t hold', () => {
    expect(
      readEditor(
        editor(
          '<div><a href="javascript:alert(1)">x</a><img src="https://t.test/p.gif"><span style="color:red">y</span></div>',
        ),
      ),
    ).toEqual([{ type: 'paragraph', runs: [{ text: 'xy' }] }]);
  });

  it('starts with an empty line when there is nothing', () => {
    const root = editor();
    writeEditor(root, []);
    expect(root.innerHTML).toBe('<div><br></div>');
    expect(readEditor(root)).toEqual([{ type: 'paragraph', runs: [] }]);
  });
});
