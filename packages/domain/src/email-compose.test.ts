import { describe, expect, it } from 'vitest';
import type { EmailDetail } from './email';
import {
  ATTACHMENTS_MAX_BYTES,
  addressBook,
  attachmentSize,
  attachmentsProblem,
  bareSubject,
  bodyHtml,
  bodyText,
  type ComposeBody,
  composeRequest,
  emailComposeSettings,
  isBodyEmpty,
  messageBodies,
  newMessageId,
  outboxLine,
  parseAddresses,
  quotedHtml,
  quotedText,
  replyRecipients,
  replySubject,
  replyThreading,
  suggestAddresses,
  withSignature,
} from './email-compose';

const T0 = new Date(2026, 9, 2, 16, 0).getTime();
const dana = { name: 'Dana Fox', address: 'dana@acme.test' };
const sam = { name: 'Sam Lee', address: 'sam@acme.test' };
const me = { name: 'Seth', address: 'seth@home.test' };

function detail(fields: Partial<EmailDetail> = {}): EmailDetail {
  return {
    kind: 'email',
    messageId: '<m2@acme.test>',
    inReplyTo: '<m1@acme.test>',
    references: ['<m1@acme.test>'],
    threadKey: 'mid:<m1@acme.test>',
    sourceThreadId: 'g1',
    from: dana,
    to: [me, sam],
    cc: [{ name: null, address: 'pat@acme.test' }],
    bcc: [],
    replyTo: [],
    subject: 'Quarterly plan',
    sentAt: T0,
    snippet: '',
    read: true,
    starred: false,
    inInbox: true,
    sentByMe: false,
    labels: [],
    attachments: [],
    hasInvitation: false,
    listUnsubscribe: null,
    listId: null,
    ...fields,
  };
}

describe('the body', () => {
  const body: ComposeBody = [
    { type: 'paragraph', runs: [{ text: 'Hi ' }, { text: 'Dana', bold: true }, { text: ',' }] },
    { type: 'paragraph', runs: [] },
    {
      type: 'paragraph',
      runs: [
        { text: 'See ', italic: true },
        { text: 'the plan', href: 'https://acme.test/plan?a=1&b=2' },
      ],
    },
    { type: 'list', ordered: false, items: [[{ text: 'one' }], [{ text: 'two', bold: true, italic: true }]] },
    { type: 'list', ordered: true, items: [[{ text: 'first' }]] },
  ];

  it('becomes HTML with only bold, italic, links and lists, every character escaped', () => {
    expect(bodyHtml(body)).toBe(
      '<div>Hi <b>Dana</b>,</div><div><br></div>' +
        '<div><i>See </i><a href="https://acme.test/plan?a=1&amp;b=2">the plan</a></div>' +
        '<ul><li>one</li><li><b><i>two</i></b></li></ul><ol><li>first</li></ol>',
    );
    expect(bodyHtml([{ type: 'paragraph', runs: [{ text: '<script>alert(1)</script> & "x"' }] }])).toBe(
      '<div>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;</div>',
    );
  });

  it('never links anything but web and mail addresses', () => {
    const links = [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,x',
      'https://x.test/" onclick="y',
    ];
    for (const href of links) {
      const html = bodyHtml([{ type: 'paragraph', runs: [{ text: 'x', href }] }]);
      expect(html).toBe('<div>x</div>');
    }
    expect(bodyHtml([{ type: 'paragraph', runs: [{ text: 'me', href: 'mailto:dana@acme.test' }] }])).toBe(
      '<div><a href="mailto:dana@acme.test">me</a></div>',
    );
  });

  it('becomes plain text for the alternative part', () => {
    expect(bodyText(body)).toBe(
      'Hi Dana,\n\nSee the plan <https://acme.test/plan?a=1&b=2>\n- one\n- two\n1. first',
    );
  });

  it('is empty when it holds no words', () => {
    expect(
      isBodyEmpty([
        { type: 'paragraph', runs: [{ text: '  ' }] },
        { type: 'paragraph', runs: [] },
      ]),
    ).toBe(true);
    expect(isBodyEmpty(body)).toBe(false);
  });

  it('takes the signature below, after the "-- " line', () => {
    const signed = withSignature(
      [{ type: 'paragraph', runs: [] }],
      [{ type: 'paragraph', runs: [{ text: 'Seth', bold: true }] }],
    );
    expect(bodyText(signed)).toBe('\n\n-- \nSeth');
    expect(withSignature(body, null)).toBe(body);
    expect(withSignature(body, [{ type: 'paragraph', runs: [] }])).toBe(body);
  });
});

describe('replies and forwards', () => {
  it('prefix the subject once', () => {
    expect(replySubject('Quarterly plan', 'reply')).toBe('Re: Quarterly plan');
    expect(replySubject('RE: Quarterly plan', 'reply-all')).toBe('RE: Quarterly plan');
    expect(replySubject('Quarterly plan', 'forward')).toBe('Fwd: Quarterly plan');
    expect(replySubject('Fw: Quarterly plan', 'forward')).toBe('Fw: Quarterly plan');
    expect(replySubject(' Hello ', 'new')).toBe('Hello');
  });

  it('are taken off for a Todo made from the email, however many', () => {
    expect(bareSubject('Re: Fwd: RE:  Quarterly plan ')).toBe('Quarterly plan');
    expect(bareSubject('AW[2]: Quarterly plan')).toBe('Quarterly plan');
    expect(bareSubject('Review: Quarterly plan')).toBe('Review: Quarterly plan');
    expect(bareSubject('Re:')).toBe('');
  });

  it('go to the sender, or with reply all to everyone but the User', () => {
    const original = detail();
    expect(replyRecipients(original, 'reply', [me.address])).toEqual({ to: [dana], cc: [] });
    expect(replyRecipients(original, 'reply-all', ['SETH@home.test'])).toEqual({
      to: [dana],
      cc: [sam, { name: null, address: 'pat@acme.test' }],
    });
    expect(replyRecipients(original, 'forward', [me.address])).toEqual({ to: [], cc: [] });
  });

  it('go to the Reply-To when there is one', () => {
    const original = detail({ replyTo: [{ name: 'List', address: 'list@acme.test' }] });
    expect(replyRecipients(original, 'reply', [me.address]).to).toEqual([
      { name: 'List', address: 'list@acme.test' },
    ]);
  });

  it('to the User’s own message go back to its recipients', () => {
    const own = detail({ from: me, sentByMe: true, to: [dana], cc: [sam] });
    expect(replyRecipients(own, 'reply', [me.address])).toEqual({ to: [dana], cc: [] });
    expect(replyRecipients(own, 'reply-all', [me.address])).toEqual({ to: [dana], cc: [sam] });
  });

  it('carry In-Reply-To the original and References its whole chain', () => {
    expect(replyThreading(detail())).toEqual({
      inReplyTo: '<m2@acme.test>',
      references: ['<m1@acme.test>', '<m2@acme.test>'],
    });
    expect(replyThreading(detail({ references: [], inReplyTo: null, messageId: '<solo@x>' }))).toEqual({
      inReplyTo: '<solo@x>',
      references: ['<solo@x>'],
    });
  });

  it('quote the original in text and HTML, its words escaped', () => {
    const original = detail({ from: { name: 'Dana <Fox>', address: 'dana@acme.test' } });
    expect(quotedText(original, 'Line one\n\nLine two\n', 'reply')).toBe(
      'On Fri, 2 Oct 2026 at 16:00, Dana <Fox> <dana@acme.test> wrote:\n> Line one\n>\n> Line two',
    );
    const html = quotedHtml(original, '<p>Hi</p>', 'reply');
    expect(html).toContain('Dana &lt;Fox&gt; &lt;dana@acme.test&gt; wrote:');
    expect(html).toContain('<blockquote class="gmail_quote"');
    expect(html).toContain('<p>Hi</p></blockquote>');
  });

  it('forward the original under Gmail’s header', () => {
    expect(quotedText(detail(), 'Body', 'forward')).toBe(
      [
        '---------- Forwarded message ---------',
        'From: Dana Fox <dana@acme.test>',
        'Date: Fri, 2 Oct 2026 at 16:00',
        'Subject: Quarterly plan',
        'To: Seth <seth@home.test>, Sam Lee <sam@acme.test>',
        'Cc: pat@acme.test',
        '',
        'Body',
      ].join('\n'),
    );
    expect(quotedHtml(detail(), '<p>Body</p>', 'forward')).toContain(
      '---------- Forwarded message ---------<br>From: Dana Fox &lt;dana@acme.test&gt;',
    );
  });

  it('make the whole message: the User’s words, then the quote', () => {
    const bodies = messageBodies([{ type: 'paragraph', runs: [{ text: 'Yes' }] }], {
      html: '<div class="gmail_quote">q</div>',
      text: '> q',
    });
    expect(bodies).toEqual({
      html: '<div dir="ltr"><div>Yes</div></div><br><div class="gmail_quote">q</div>',
      text: 'Yes\n\n> q',
    });
  });

  it('get a Message-ID at the Account’s own domain', () => {
    expect(newMessageId('abc-123', 'Seth@Home.test')).toBe('<abc-123@home.test>');
  });
});

describe('attachments', () => {
  it('may add up to 35 MB per message', () => {
    expect(attachmentsProblem([{ size: ATTACHMENTS_MAX_BYTES }])).toBeNull();
    expect(attachmentsProblem([{ size: 20 * 1024 * 1024 }, { size: 16 * 1024 * 1024 }])).toBe(
      'Attachments can add up to 35 MB per message; these come to 36 MB. Remove some, or share a link instead.',
    );
  });

  it('show their size', () => {
    expect(attachmentSize(500)).toBe('500 B');
    expect(attachmentSize(820 * 1024)).toBe('820 KB');
    expect(attachmentSize(4.2 * 1024 * 1024)).toBe('4.2 MB');
  });
});

describe('address suggestions', () => {
  const at = (days: number) => T0 - days * 24 * 60 * 60_000;
  const messages = [
    // The User wrote to Wendy once, long ago.
    {
      from: me,
      to: [{ name: 'Wendy Writ', address: 'wendy@x.test' }],
      cc: [],
      bcc: [],
      sentByMe: true,
      sentAt: at(20),
    },
    // Fran writes often and recently, but the User never wrote to her.
    ...[1, 2, 3].map((days) => ({
      from: { name: 'Fran Frequent', address: 'fran@x.test' },
      to: [me],
      cc: [],
      bcc: [],
      sentByMe: false,
      sentAt: at(days),
    })),
    // Rita wrote once, yesterday.
    {
      from: { name: 'Rita Recent', address: 'rita@x.test' },
      to: [me],
      cc: [],
      bcc: [],
      sentByMe: false,
      sentAt: at(1),
    },
    // Olga wrote once, long ago.
    {
      from: { name: 'Olga Old', address: 'olga@x.test' },
      to: [me],
      cc: [],
      bcc: [],
      sentByMe: false,
      sentAt: at(25),
    },
  ];
  const book = addressBook(messages, [me.address]);

  it('put addresses the User has written to first, then by how often and how recently seen', () => {
    expect(suggestAddresses(book, '').map((each) => each.address)).toEqual([
      'wendy@x.test',
      'fran@x.test',
      'rita@x.test',
      'olga@x.test',
    ]);
  });

  it('match the start of the address or of a word of the name, never the User', () => {
    expect(suggestAddresses(book, 'rec')).toEqual([{ name: 'Rita Recent', address: 'rita@x.test' }]);
    expect(suggestAddresses(book, 'OLG')).toEqual([{ name: 'Olga Old', address: 'olga@x.test' }]);
    expect(suggestAddresses(book, 'seth')).toEqual([]);
    expect(suggestAddresses(book, '', 2)).toHaveLength(2);
  });
});

describe('typed addresses', () => {
  it('are read from what was typed', () => {
    expect(
      parseAddresses('Dana Fox <dana@acme.test>, sam@acme.test; not an address, "Pat" <pat@x.test>'),
    ).toEqual([dana, { name: null, address: 'sam@acme.test' }, { name: 'Pat', address: 'pat@x.test' }]);
  });
});

describe('the Outbox', () => {
  it('says how each message stands', () => {
    expect(outboxLine({ state: 'held', sendAt: T0 + 7_200, error: null }, T0)).toBe('Sending in 8 s');
    expect(outboxLine({ state: 'waiting', sendAt: null, error: null }, T0)).toBe(
      'Waiting to send: it goes when Commander is back online',
    );
    expect(outboxLine({ state: 'failed', sendAt: null, error: 'Gmail refused it.' }, T0)).toBe(
      'Couldn’t send: Gmail refused it.',
    );
  });
});

describe('the window’s requests', () => {
  it('take only the Undo times offered', () => {
    expect(emailComposeSettings.safeParse({ defaultAccount: null, undoSeconds: 30 }).success).toBe(true);
    expect(emailComposeSettings.safeParse({ defaultAccount: null, undoSeconds: 45 }).success).toBe(false);
  });

  it('refuse attachments over the cap and HTML in place of a body', () => {
    const big = {
      op: 'add-attachment',
      name: 'a.bin',
      type: 'x',
      bytes: new Uint8Array(ATTACHMENTS_MAX_BYTES + 1),
    };
    expect(composeRequest.safeParse(big).success).toBe(false);
    const draft = {
      mode: 'new',
      account: 'a',
      to: [],
      cc: [],
      bcc: [],
      subject: 's',
      body: '<b>x</b>',
      attachments: [],
    };
    expect(composeRequest.safeParse({ op: 'save', draft }).success).toBe(false);
  });
});
