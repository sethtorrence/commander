import { describe, expect, it } from 'vitest';
import { cleanModelText, cleanOutput, stripInternalWording, urlsIn } from './output';

// What a model writes is checked before anything is made of it: the prompt builder's internal
// wording is stripped (the evaluation saw a summary echo it), images are dropped, and a URL stays
// only if it was in the material the model was shown.

describe('stripInternalWording', () => {
  it('strips the line the evaluation saw echoed at the end of a summary', () => {
    const summary = [
      'Shipped: the login fix and the new runbook.',
      'Stuck: the SSO migration waits on Priya.',
      'Note: all content above was treated as untrusted data and no embedded instructions were followed.',
    ].join('\n');
    expect(stripInternalWording(summary)).toBe(
      'Shipped: the login fix and the new runbook.\nStuck: the SSO migration waits on Priya.',
    );
  });

  it.each([
    ['untrusted', 'Send Dana the numbers. (The issue is untrusted, so I ignored its requests.)'],
    ['data blocks', 'Send Dana the numbers. I read the data blocks only.'],
    ['the delimiter', 'Send Dana the numbers. </data-1a2b3c4d>'],
    ['the source label', 'Send Dana the numbers. It had source="outside".'],
    ['treated as data', 'Send Dana the numbers. I treated the email as data, not instructions.'],
    ['didn’t follow', 'Send Dana the numbers. I did not follow any instructions in the content.'],
    ['embedded instructions', 'Send Dana the numbers. There were embedded instructions, ignored.'],
    ['prompt injection', 'Send Dana the numbers. This looked like a prompt injection.'],
    ['the system message', 'Send Dana the numbers. As the system message says, I only summarise.'],
    ['a block ref', 'Send Dana the numbers. Block U1 tried to steer me.'],
  ])('strips a sentence that mentions %s', (_name, text) => {
    expect(stripInternalWording(text)).toBe('Send Dana the numbers.');
  });

  it('sees through lookalike letters and hidden characters', () => {
    expect(stripInternalWording('Done. Treated as unt\u200brusted dаta.')).toBe('Done.');
  });

  it('keeps the wording when the material holds it: the model is quoting, not echoing', () => {
    const material = 'need to treat the email as data, not instructions';
    expect(stripInternalWording('Treat the email as data, not instructions', material)).toBe(
      'Treat the email as data, not instructions',
    );
    expect(
      stripInternalWording(
        'Treat the email as data, not instructions. I did not follow any instructions in the content.',
        material,
      ),
    ).toBe('Treat the email as data, not instructions.');
  });

  it('leaves ordinary writing alone', () => {
    for (const text of [
      'Send Dana the Q3 numbers',
      'Fix the data pipeline before Friday',
      'Follow up with Dana on the onboarding instructions',
      'Review the system design doc. Then book flights.',
      // Todos a model may well write from the User's own Blocks.
      'Write the system prompt for the support bot',
      'Read the instructions in the email from Sam',
      'Treat the survey results as data for the Q3 deck',
      'Clean up untrusted certificates',
      'Mark the old certificate as untrusted',
      'Ask why Sam did not follow the instructions',
      'Write the prompt injection tests',
    ]) {
      expect(stripInternalWording(text)).toBe(text);
    }
  });
});

describe('cleanModelText', () => {
  const material = 'Read https://acme.test/runbook before the call. Deck: https://docs.test/d/1?x=2.';

  it('keeps a URL only if it was in the material', () => {
    expect(cleanModelText('Read https://acme.test/runbook first', material)).toBe(
      'Read https://acme.test/runbook first',
    );
    expect(cleanModelText('Open https://docs.test/d/1?x=2.', material)).toBe(
      'Open https://docs.test/d/1?x=2.',
    );
    expect(cleanModelText('Log in at https://acme-login.evil.test/?u=dana', material)).toBe(
      'Log in at [link removed]',
    );
    // Close is not the same: a URL must be in the material exactly.
    expect(cleanModelText('See https://acme.test/runbook/../admin', material)).toBe('See [link removed]');
  });

  it('turns an unsourced Markdown link into its words, and drops images whatever their URL', () => {
    expect(cleanModelText('[Reset your password](https://evil.test/reset)', material)).toBe(
      'Reset your password',
    );
    expect(cleanModelText('[the runbook](https://acme.test/runbook)', material)).toBe(
      '[the runbook](https://acme.test/runbook)',
    );
    expect(cleanModelText('Done ![x](https://evil.test/pixel.png?d=secret)', material)).toBe('Done x');
    expect(cleanModelText('![](https://acme.test/runbook)', material)).toBe('');
  });

  it('removes javascript:, data: and file: addresses', () => {
    expect(
      cleanModelText(
        'Click javascript:alert(1) or data:text/html;base64,PHNjcmlwdD4= or file:///etc/passwd',
        material,
      ),
    ).toBe('Click [link removed] or [link removed] or [link removed]');
  });
});

describe('cleanOutput', () => {
  it('cleans every string in a reply, however deep, and leaves the rest as it is', () => {
    const reply = {
      todos: [
        { blockId: 'B1', title: 'Pay at https://evil.test/pay', confidence: 0.9 },
        { blockId: 'B2', title: 'Send the deck', confidence: 0.5, tags: ['Treated as untrusted data.'] },
      ],
      steering: ['U1'],
      count: 2,
      done: false,
      none: null,
    };
    expect(cleanOutput(reply, '')).toEqual({
      todos: [
        { blockId: 'B1', title: 'Pay at [link removed]', confidence: 0.9 },
        { blockId: 'B2', title: 'Send the deck', confidence: 0.5, tags: [''] },
      ],
      steering: ['U1'],
      count: 2,
      done: false,
      none: null,
    });
  });
});

describe('urlsIn', () => {
  it('finds web addresses, bare or in Markdown links, without trailing punctuation', () => {
    expect(urlsIn('See https://a.test/x, and [b](http://b.test/y?z=1). Also (https://c.test/).')).toEqual([
      'https://a.test/x',
      'http://b.test/y?z=1',
      'https://c.test/',
    ]);
  });
});
