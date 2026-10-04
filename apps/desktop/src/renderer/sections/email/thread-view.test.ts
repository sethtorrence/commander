import type { EmailDetail } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { expandedAtFirst, fileSize, splitQuote, textPieces } from './thread-view';

const message = (id: string, read: boolean) => ({ item: { id, detail: { read } as EmailDetail } });

describe('which messages a thread shows expanded at first', () => {
  it('expands the newest message and the unread ones, and collapses older read ones', () => {
    const thread = [message('a', true), message('b', false), message('c', true), message('d', true)];
    expect([...expandedAtFirst(thread)]).toEqual(['b', 'd']);
  });

  it('expands a thread’s only message', () => {
    expect([...expandedAtFirst([message('a', true)])]).toEqual(['a']);
  });
});

describe('folding a plain-text message’s quoted history', () => {
  it('folds the trailing quote after an attribution line', () => {
    const text =
      'Sounds good.\n\nOn Fri, 2 Oct 2026 at 09:00, Dana <dana@x.test> wrote:\n> Are we on?\n>\n> Dana';
    expect(splitQuote(text)).toEqual({
      body: 'Sounds good.',
      quote: 'On Fri, 2 Oct 2026 at 09:00, Dana <dana@x.test> wrote:\n> Are we on?\n>\n> Dana',
    });
  });

  it('folds a trailing block of > lines, and Outlook’s original message', () => {
    expect(splitQuote('Yes.\n> Coming?\n> Bring snacks')).toEqual({
      body: 'Yes.',
      quote: '> Coming?\n> Bring snacks',
    });
    expect(splitQuote('Done.\n\n-----Original Message-----\nFrom: Dana\nCan you?').quote).toBe(
      '-----Original Message-----\nFrom: Dana\nCan you?',
    );
  });

  it('leaves replies written between the quoted lines, and messages that are only a quote', () => {
    const inline = '> First?\nAnswer one.\n> Second?\nAnswer two.';
    expect(splitQuote(inline)).toEqual({ body: inline, quote: null });
    expect(splitQuote('> just a quote')).toEqual({ body: '> just a quote', quote: null });
    expect(splitQuote('No quote here.')).toEqual({ body: 'No quote here.', quote: null });
  });
});

describe('a plain-text body’s pieces', () => {
  it('turns web and mail addresses into links and leaves the rest as text, keeping every character', () => {
    const text = 'See https://x.test/a?b=1, or mail help@x.test.\n<b>not markup</b>';
    const pieces = textPieces(text);
    expect(pieces.map((piece) => piece.text).join('')).toBe(text);
    expect(pieces.filter((piece) => piece.href).map((piece) => piece.href)).toEqual([
      'https://x.test/a?b=1',
      'mailto:help@x.test',
    ]);
  });

  it('never links anything but the web and mail', () => {
    const pieces = textPieces('javascript:alert(1) file:///etc/passwd data:text/html,x');
    expect(pieces.some((piece) => piece.href)).toBe(false);
  });
});

describe('file sizes', () => {
  it('reads like a mail client', () => {
    expect(fileSize(900)).toBe('900 B');
    expect(fileSize(183_002)).toBe('179 KB');
    expect(fileSize(5_400_000)).toBe('5.1 MB');
  });
});
