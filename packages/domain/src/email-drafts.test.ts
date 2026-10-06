import { describe, expect, it } from 'vitest';
import {
  bodyHtml,
  bodyText,
  messageBodies,
  settleAresLink,
  unkeptLinks,
  withSignature,
} from './email-compose';
import { cleanEmailDraft, draftBody, draftUrls, suggestedReply } from './email-drafts';

// Ares's drafts as the composer takes them (#143): a paragraph per line, the links he added marked,
// and nothing marked ever part of the message until the User keeps it.

const ADDED = 'https://cal.example/alex';
const THREAD = 'https://northwind.test/agenda';

describe('Ares’s draft in the composer', () => {
  it('makes a paragraph of each line, marking only the links he added', () => {
    const body = draftBody(`Hi Dana,\n\nThe agenda: ${THREAD}. Book me at ${ADDED}.\n\nCheers,\nAlex`, [
      ADDED,
    ]);
    expect(body).toEqual([
      { type: 'paragraph', runs: [{ text: 'Hi Dana,' }] },
      { type: 'paragraph', runs: [] },
      {
        type: 'paragraph',
        runs: [
          { text: `The agenda: ${THREAD}. Book me at ` },
          { text: ADDED, aresLink: true },
          { text: '.' },
        ],
      },
      { type: 'paragraph', runs: [] },
      { type: 'paragraph', runs: [{ text: 'Cheers,' }] },
      { type: 'paragraph', runs: [{ text: 'Alex' }] },
    ]);
    expect(unkeptLinks(body)).toEqual([ADDED]);
  });

  it('leaves a link he added out of the message’s HTML and text, Drafts and sends alike, until it is kept', () => {
    const body = withSignature(draftBody(`Book me at ${ADDED} please`, [ADDED]), [
      { type: 'paragraph', runs: [{ text: 'Alex Kim' }] },
    ]);
    expect(bodyHtml(body)).not.toContain('cal.example');
    expect(bodyText(body)).not.toContain('cal.example');
    expect(bodyText(body)).toContain('Book me at  please');
    expect(messageBodies(body, null).html).not.toContain('cal.example');

    const kept = settleAresLink(body, ADDED, true);
    expect(unkeptLinks(kept)).toEqual([]);
    expect(bodyText(kept)).toContain(`Book me at ${ADDED} please`);

    const removed = settleAresLink(body, ADDED, false);
    expect(unkeptLinks(removed)).toEqual([]);
    expect(bodyText(removed)).toContain('Book me at  please');
    expect(JSON.stringify(removed)).not.toContain('cal.example');
  });

  it('finds the web addresses in a draft without their trailing punctuation', () => {
    expect(draftUrls(`See ${THREAD}, and ${ADDED}.`)).toEqual([THREAD, ADDED]);
  });

  it('tidies a draft: line breaks kept, runs of blank lines and trailing spaces gone', () => {
    expect(cleanEmailDraft('  Hi Dana,  \r\n\r\n\r\n\r\nYes.\n')).toBe('Hi Dana,\n\nYes.');
  });

  it('describes a suggested reply as offered or ready', () => {
    expect(suggestedReply.parse({ state: 'offered', answering: 'm1' })).toEqual({
      state: 'offered',
      answering: 'm1',
    });
    expect(
      suggestedReply.safeParse({
        state: 'ready',
        answering: 'm1',
        body: '',
        addedLinks: [],
        confidence: 0.9,
        sure: true,
        at: 1,
      }).success,
    ).toBe(false);
  });
});
