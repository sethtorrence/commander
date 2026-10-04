import { EMAIL_HTML_MAX, EMAIL_TEXT_MAX, type EmailBody, type EmailDetail } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { decodeHeader, parseAddresses, readGmailMessage } from './message';
import type { GmailMessage, GmailPart } from './shapes';

// Reading a Gmail message (`messages.get?format=full`) into an email Item and its bodies, over the
// shapes real mail comes in. Gmail hands each part's data base64url-encoded and already undoes the
// part's Content-Transfer-Encoding (quoted-printable, base64), but leaves its bytes in the part's
// own charset, and leaves encoded words in headers to the reader.

const LABELS = new Map([
  ['INBOX', 'INBOX'],
  ['UNREAD', 'UNREAD'],
  ['STARRED', 'STARRED'],
  ['SENT', 'SENT'],
  ['IMPORTANT', 'IMPORTANT'],
  ['CATEGORY_UPDATES', 'CATEGORY_UPDATES'],
  ['Label_7', 'Receipts'],
]);

const data = (text: string | Uint8Array) => Buffer.from(text).toString('base64url');
const latin1 = (text: string) => Buffer.from(text, 'latin1');

type PartSpec = {
  headers?: Record<string, string>;
  data?: string | Uint8Array;
  filename?: string;
  attachmentId?: string;
  size?: number;
  parts?: GmailPart[];
};

let nextPart = 0;
function part(mimeType: string, spec: PartSpec = {}): GmailPart {
  const charset = /^text\//.test(mimeType) && !spec.headers?.['Content-Type'] ? '; charset="UTF-8"' : '';
  const headers = { 'Content-Type': `${mimeType}${charset}`, ...spec.headers };
  return {
    partId: String(nextPart++),
    mimeType,
    filename: spec.filename ?? '',
    headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
    body: {
      size: spec.size ?? (spec.data ? Buffer.from(spec.data).length : 0),
      ...(spec.data !== undefined ? { data: data(spec.data) } : {}),
      ...(spec.attachmentId ? { attachmentId: spec.attachmentId } : {}),
    },
    ...(spec.parts ? { parts: spec.parts } : {}),
  };
}

function gmail(
  payload: GmailPart,
  fields: Partial<GmailMessage> = {},
  headers: Record<string, string> = {},
): GmailMessage {
  const top: Record<string, string> = {
    From: 'Dana Whitfield <dana@northwind.test>',
    To: 'Alex Kim <alex@gmail.test>',
    Subject: 'Q4 offsite dates',
    Date: 'Thu, 1 Oct 2026 09:14:00 +0000',
    'Message-ID': '<CAF=offsite-1@mail.northwind.test>',
    ...headers,
  };
  return {
    id: '1928a0b0c0d0e0f1',
    threadId: '1928a0b0c0d0e0f1',
    labelIds: ['INBOX', 'UNREAD', 'IMPORTANT'],
    snippet: 'Which dates work for you? I&#39;d like to book by Friday.',
    historyId: '84210',
    internalDate: String(Date.UTC(2026, 9, 1, 9, 14)),
    sizeEstimate: 4200,
    ...fields,
    payload: {
      ...payload,
      headers: [...Object.entries(top).map(([name, value]) => ({ name, value })), ...(payload.headers ?? [])],
    },
  };
}

const read = (message: GmailMessage) => {
  const item = readGmailMessage(message, LABELS);
  return { item, detail: item.detail as EmailDetail, body: item.body as EmailBody };
};

describe('readGmailMessage: bodies', () => {
  it('takes the text and HTML of a multipart/alternative message', () => {
    const { body } = read(
      gmail(
        part('multipart/alternative', {
          parts: [
            part('text/plain', { data: 'Which dates work?\r\n\r\nDana' }),
            part('text/html', { data: '<p>Which dates <b>work</b>?</p><p>Dana</p>' }),
          ],
        }),
      ),
    );

    expect(body).toEqual({
      text: 'Which dates work?\n\nDana',
      html: '<p>Which dates <b>work</b>?</p><p>Dana</p>',
      textFromHtml: false,
      truncated: false,
    });
  });

  it('turns an HTML-only message into text, keeping the HTML unrendered for the reader', () => {
    const html =
      '<html><head><style>p{color:red}</style></head><body><p>Hello <a href="https://northwind.test/rsvp">RSVP here</a></p><ul><li>Fri</li><li>Sat</li></ul><script>alert(1)</script></body></html>';

    const { body } = read(gmail(part('text/html', { data: html })));

    expect(body.text).toBe('Hello RSVP here (https://northwind.test/rsvp)\n\n- Fri\n- Sat');
    expect(body.html).toBe(html);
    expect(body.textFromHtml).toBe(true);
  });

  it('finds the bodies and attachments of a nested mixed / related / alternative message', () => {
    const { detail, body } = read(
      gmail(
        part('multipart/mixed', {
          parts: [
            part('multipart/related', {
              parts: [
                part('multipart/alternative', {
                  parts: [
                    part('text/plain', { data: 'See the floor plan.' }),
                    part('text/html', { data: '<p>See the <img src="cid:plan"> floor plan.</p>' }),
                  ],
                }),
                part('image/png', {
                  filename: 'plan.png',
                  attachmentId: 'ANGjdJ-inline',
                  size: 51234,
                  headers: {
                    'Content-Type': 'image/png; name="plan.png"',
                    'Content-Disposition': 'inline; filename="plan.png"',
                    'Content-ID': '<plan>',
                  },
                }),
              ],
            }),
            part('application/pdf', {
              filename: 'Agenda.pdf',
              attachmentId: 'ANGjdJ-agenda',
              size: 183_002,
              headers: {
                'Content-Type': 'application/pdf; name="Agenda.pdf"',
                'Content-Disposition': 'attachment; filename="Agenda.pdf"',
              },
            }),
          ],
        }),
      ),
    );

    expect(body.text).toBe('See the floor plan.');
    expect(body.html).toBe('<p>See the <img src="cid:plan"> floor plan.</p>');
    expect(detail.attachments).toEqual([
      {
        name: 'plan.png',
        type: 'image/png',
        size: 51234,
        partId: expect.any(String),
        inline: true,
        contentId: 'plan',
      },
      {
        name: 'Agenda.pdf',
        type: 'application/pdf',
        size: 183_002,
        partId: expect.any(String),
        inline: false,
      },
    ]);
  });

  it('joins the text parts of a mixed message, around an attachment', () => {
    const { body } = read(
      gmail(
        part('multipart/mixed', {
          parts: [
            part('text/plain', { data: 'Before the attachment.' }),
            part('text/csv', {
              filename: 'dates.csv',
              attachmentId: 'ANGjdJ-csv',
              size: 40,
              headers: {
                'Content-Type': 'text/csv; name="dates.csv"',
                'Content-Disposition': 'attachment; filename="dates.csv"',
              },
            }),
            part('text/plain', { data: 'And after it.' }),
          ],
        }),
      ),
    );

    expect(body.text).toBe('Before the attachment.\n\nAnd after it.');
  });

  it('decodes each part in its own charset', () => {
    const { body } = read(
      gmail(
        part('multipart/alternative', {
          parts: [
            part('text/plain', {
              data: latin1('Café à 10h, merci'),
              headers: { 'Content-Type': 'text/plain; charset=ISO-8859-1' },
            }),
            part('text/html', {
              data: Buffer.from([0x3c, 0x70, 0x3e, 0x80, 0x35, 0x30, 0x3c, 0x2f, 0x70, 0x3e]),
              headers: { 'Content-Type': 'text/html; charset="windows-1252"' },
            }),
          ],
        }),
      ),
    );

    expect(body.text).toBe('Café à 10h, merci');
    expect(body.html).toBe('<p>€50</p>');
  });

  it('reads a charset it doesn’t know as UTF-8 rather than failing', () => {
    const { body } = read(
      gmail(
        part('text/plain', { data: 'Grüße', headers: { 'Content-Type': 'text/plain; charset=x-made-up' } }),
      ),
    );

    expect(body.text).toBe('Grüße');
  });

  it('never decodes quoted-printable or base64 a second time: Gmail has already undone them', () => {
    const { body } = read(
      gmail(
        part('multipart/alternative', {
          parts: [
            part('text/plain', {
              data: 'Total =3D 4 nights, a=b',
              headers: { 'Content-Transfer-Encoding': 'quoted-printable' },
            }),
            part('text/html', {
              data: '<p>U29tZQ== stays</p>',
              headers: { 'Content-Transfer-Encoding': 'base64' },
            }),
          ],
        }),
      ),
    );

    expect(body.text).toBe('Total =3D 4 nights, a=b');
    expect(body.html).toBe('<p>U29tZQ== stays</p>');
  });

  it('marks a calendar invitation', () => {
    const { detail } = read(
      gmail(
        part('multipart/mixed', {
          parts: [
            part('multipart/alternative', {
              parts: [
                part('text/plain', { data: 'Invitation: Offsite' }),
                part('text/calendar', {
                  data: 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR',
                  headers: { 'Content-Type': 'text/calendar; charset="UTF-8"; method=REQUEST' },
                }),
              ],
            }),
            part('application/ics', {
              filename: 'invite.ics',
              attachmentId: 'ANGjdJ-ics',
              size: 1200,
              headers: {
                'Content-Type': 'application/ics; name="invite.ics"',
                'Content-Disposition': 'attachment; filename="invite.ics"',
              },
            }),
          ],
        }),
      ),
    );

    expect(detail.hasInvitation).toBe(true);
    expect(detail.attachments.map((each) => each.name)).toEqual(['invite.ics']);
  });

  it('cuts a very long text body and leaves a very large HTML body to be fetched when read', () => {
    const { body } = read(
      gmail(
        part('multipart/alternative', {
          parts: [
            part('text/plain', { data: 'a'.repeat(EMAIL_TEXT_MAX + 10) }),
            part('text/html', { data: `<p>${'b'.repeat(EMAIL_HTML_MAX)}</p>` }),
          ],
        }),
      ),
    );

    expect(body.text).toHaveLength(EMAIL_TEXT_MAX);
    expect(body.html).toBeNull();
    expect(body.truncated).toBe(true);
  });

  it('keeps an empty body for a message with none', () => {
    const { body } = read(gmail(part('text/plain', {})));

    expect(body).toEqual({ text: '', html: null, textFromHtml: false, truncated: false });
  });
});

describe('readGmailMessage: headers, labels and the Item', () => {
  it('makes an open, unread email Item from an inbox message', () => {
    const { item, detail } = read(
      gmail(
        part('text/plain', { data: 'Which dates work for you?' }),
        {},
        {
          Cc: '"Kim, Alex" <alex.kim@northwind.test>, ops@northwind.test',
          'Reply-To': 'Offsite <offsite@northwind.test>',
          'In-Reply-To': '<CAF=offsite-0@mail.northwind.test>',
          References: '<CAF=root@mail.northwind.test>\r\n <CAF=offsite-0@mail.northwind.test>',
          'List-Unsubscribe': '<mailto:leave@northwind.test>, <https://northwind.test/u/1>',
          'List-Id': 'Offsite planning <offsite.northwind.test>',
        },
      ),
    );

    expect(item).toMatchObject({
      externalId: '1928a0b0c0d0e0f1',
      kind: 'email',
      title: 'Q4 offsite dates',
      status: 'open',
    });
    expect(item.people).toEqual([
      'dana@northwind.test',
      'alex@gmail.test',
      'alex.kim@northwind.test',
      'ops@northwind.test',
      'offsite@northwind.test',
    ]);
    expect(detail).toMatchObject({
      kind: 'email',
      messageId: '<CAF=offsite-1@mail.northwind.test>',
      inReplyTo: '<CAF=offsite-0@mail.northwind.test>',
      references: ['<CAF=root@mail.northwind.test>', '<CAF=offsite-0@mail.northwind.test>'],
      sourceThreadId: '1928a0b0c0d0e0f1',
      from: { name: 'Dana Whitfield', address: 'dana@northwind.test' },
      to: [{ name: 'Alex Kim', address: 'alex@gmail.test' }],
      cc: [
        { name: 'Kim, Alex', address: 'alex.kim@northwind.test' },
        { name: null, address: 'ops@northwind.test' },
      ],
      bcc: [],
      replyTo: [{ name: 'Offsite', address: 'offsite@northwind.test' }],
      subject: 'Q4 offsite dates',
      sentAt: Date.UTC(2026, 9, 1, 9, 14),
      snippet: "Which dates work for you? I'd like to book by Friday.",
      read: false,
      starred: false,
      inInbox: true,
      sentByMe: false,
      hasInvitation: false,
      listUnsubscribe: '<mailto:leave@northwind.test>, <https://northwind.test/u/1>',
      listId: 'Offsite planning <offsite.northwind.test>',
    });
    expect(detail.threadKey).toEqual(expect.any(String));
    expect(detail.labels).toEqual([
      { id: 'INBOX', name: 'Inbox' },
      { id: 'UNREAD', name: 'Unread' },
      { id: 'IMPORTANT', name: 'Important' },
    ]);
  });

  it('archives a message out of the inbox, and reads read, starred, sent and the User’s labels', () => {
    const { item, detail } = read(
      gmail(part('text/plain', { data: 'Receipt' }), {
        labelIds: ['STARRED', 'SENT', 'Label_7', 'CATEGORY_UPDATES'],
      }),
    );

    expect(item.status).toBe('archived');
    expect(detail).toMatchObject({ read: true, starred: true, inInbox: false, sentByMe: true });
    expect(detail.labels).toEqual([
      { id: 'STARRED', name: 'Starred' },
      { id: 'SENT', name: 'Sent' },
      { id: 'Label_7', name: 'Receipts' },
      { id: 'CATEGORY_UPDATES', name: 'Updates' },
    ]);
  });

  it('decodes encoded words in the subject and names', () => {
    const { item, detail } = read(
      gmail(
        part('text/plain', { data: 'x' }),
        {},
        {
          Subject: '=?UTF-8?B?UmU6IETDqWrDoCB2dQ==?= =?UTF-8?Q?_=E2=80=94_offsite?=',
          From: '=?ISO-8859-1?Q?Ren=E9e_Fran=E7ois?= <renee@example.test>',
        },
      ),
    );

    expect(item.title).toBe('Re: Déjà vu — offsite');
    expect(detail.from).toEqual({ name: 'Renée François', address: 'renee@example.test' });
  });

  it('titles a message with no subject', () => {
    const { item, detail } = read(gmail(part('text/plain', { data: 'x' }), {}, { Subject: '' }));

    expect(item.title).toBe('(no subject)');
    expect(detail.subject).toBe('');
  });
});

describe('headers', () => {
  it('decodes RFC 2047 encoded words, joining adjacent ones', () => {
    expect(decodeHeader('=?utf-8?q?caf=C3=A9?= =?utf-8?q?_ouvert?=')).toBe('café ouvert');
    expect(decodeHeader('Plain =?UTF-8?B?w6l0w6k=?= text')).toBe('Plain été text');
    expect(decodeHeader('Not =?encoded')).toBe('Not =?encoded');
  });

  it('reads address lists with quoted names, comments, groups and bare addresses', () => {
    expect(
      parseAddresses(
        '"Doe, Jane" <jane@x.test>, bob@y.test (Bob), undisclosed-recipients:;, Team: a@z.test, b@z.test;',
      ),
    ).toEqual([
      { name: 'Doe, Jane', address: 'jane@x.test' },
      { name: 'Bob', address: 'bob@y.test' },
      { name: null, address: 'a@z.test' },
      { name: null, address: 'b@z.test' },
    ]);
    expect(parseAddresses('')).toEqual([]);
  });
});
