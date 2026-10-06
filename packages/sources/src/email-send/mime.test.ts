import {
  type ComposeBody,
  messageBodies,
  type OutgoingMessage,
  quotedHtml,
  quotedText,
  withSignature,
} from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { buildMime, COMMANDER_ID_HEADER } from './mime';
import { mimeHeader, mimeLeaves, parseMime } from './parse-mime';

// The MIME Commander sends through Gmail (#138): formatting as HTML with a plain-text alternative, the
// signature in the body, the quote below, attachments after, and the headers that thread it. The
// snapshots are the whole message, with the date and boundaries fixed.

const DATE = new Date(Date.UTC(2026, 9, 6, 9, 30));
const original = {
  from: { name: 'Dana Fox', address: 'dana@acme.test' },
  sentAt: new Date(2026, 9, 2, 16, 0).getTime(),
  subject: 'Quarterly plan',
  to: [{ name: 'Seth', address: 'seth@home.test' }],
  cc: [],
};
const body: ComposeBody = [
  { type: 'paragraph', runs: [{ text: 'Hi ' }, { text: 'Dana', bold: true }, { text: ',' }] },
  {
    type: 'paragraph',
    runs: [
      { text: 'Looks good — ', italic: true },
      { text: 'notes here', href: 'https://acme.test/notes' },
    ],
  },
  { type: 'list', ordered: false, items: [[{ text: 'Budget' }], [{ text: 'Hiring' }]] },
];
const signature: ComposeBody = [{ type: 'paragraph', runs: [{ text: 'Seth Torrence', bold: true }] }];

function message(fields: Partial<OutgoingMessage> = {}): OutgoingMessage {
  const quote = {
    html: quotedHtml(original, '<div>Can you look at the plan?</div>', 'reply'),
    text: quotedText(original, 'Can you look at the plan?', 'reply'),
  };
  const bodies = messageBodies(withSignature(body, signature), quote);
  return {
    commanderId: '7f1c2a10-3b4c-4d5e-8f90-a1b2c3d4e5f6',
    messageId: '<7f1c2a10-3b4c-4d5e-8f90-a1b2c3d4e5f6@home.test>',
    mode: 'reply',
    from: { name: 'Seth Torrence', address: 'seth@home.test' },
    to: [{ name: 'Dana Fox', address: 'dana@acme.test' }],
    cc: [{ name: null, address: 'sam@acme.test' }],
    bcc: [{ name: null, address: 'archive@home.test' }],
    subject: 'Re: Quarterly plan',
    html: bodies.html,
    text: bodies.text,
    attachments: [],
    inReplyTo: '<m2@acme.test>',
    references: ['<m1@acme.test>', '<m2@acme.test>'],
    sourceThreadId: 'thread-1',
    replyToExternalId: 'msg-2',
    ...fields,
  };
}

const ATTACHMENT = {
  id: '0b5d4c3a-2f1e-4d0c-9b8a-7f6e5d4c3b2a',
  name: 'plan.pdf',
  type: 'application/pdf',
  size: 9,
};
const files = new Map([[ATTACHMENT.id, new TextEncoder().encode('%PDF-1.7\n')]]);

describe('buildMime', () => {
  it('sends the formatted reply as HTML with a plain-text alternative, signed and quoted', async () => {
    const raw = await buildMime(message(), files, { date: DATE, baseBoundary: 'commander-test' });
    await expect(raw.toString('utf8')).toMatchFileSnapshot('./__snapshots__/reply.eml');

    const parsed = parseMime(raw);
    expect(parsed.type).toBe('multipart/alternative');
    expect(mimeHeader(parsed, 'In-Reply-To')).toBe('<m2@acme.test>');
    expect(mimeHeader(parsed, 'References')).toBe('<m1@acme.test> <m2@acme.test>');
    expect(mimeHeader(parsed, 'Message-ID')).toBe('<7f1c2a10-3b4c-4d5e-8f90-a1b2c3d4e5f6@home.test>');
    expect(mimeHeader(parsed, COMMANDER_ID_HEADER)).toBe('7f1c2a10-3b4c-4d5e-8f90-a1b2c3d4e5f6');
    // Gmail delivers to Bcc from the header, and leaves it off what the recipients get.
    expect(mimeHeader(parsed, 'Bcc')).toBe('archive@home.test');
    const [text, html] = mimeLeaves(parsed);
    expect(text?.type).toBe('text/plain');
    expect(text?.body.toString('utf8')).toBe(
      'Hi Dana,\nLooks good — notes here <https://acme.test/notes>\n- Budget\n- Hiring\n\n-- \nSeth Torrence\n\n' +
        'On Fri, 2 Oct 2026 at 16:00, Dana Fox <dana@acme.test> wrote:\n> Can you look at the plan?',
    );
    expect(html?.type).toBe('text/html');
    expect(html?.body.toString('utf8')).toContain(
      '<div>Hi <b>Dana</b>,</div><div><i>Looks good — </i><a href="https://acme.test/notes">notes here</a></div>',
    );
    expect(html?.body.toString('utf8')).toContain('<ul><li>Budget</li><li>Hiring</li></ul>');
    expect(html?.body.toString('utf8')).toContain('<div><b>Seth Torrence</b></div>');
    expect(html?.body.toString('utf8')).toContain('<blockquote class="gmail_quote"');
  });

  it('puts attachments after the body, with their names and types', async () => {
    const raw = await buildMime(message({ attachments: [ATTACHMENT] }), files, {
      date: DATE,
      baseBoundary: 'commander-test',
    });
    await expect(raw.toString('utf8')).toMatchFileSnapshot('./__snapshots__/reply-with-attachment.eml');

    const parsed = parseMime(raw);
    expect(parsed.type).toBe('multipart/mixed');
    expect(parsed.parts.map((part) => part.type)).toEqual(['multipart/alternative', 'application/pdf']);
    const attached = parsed.parts[1];
    expect(attached?.disposition).toBe('attachment');
    expect(attached?.filename).toBe('plan.pdf');
    expect(attached?.body.toString('utf8')).toBe('%PDF-1.7\n');
  });

  it('starts new mail without reply headers', async () => {
    const parsed = parseMime(
      await buildMime(message({ mode: 'new', inReplyTo: null, references: [], subject: 'Hello' }), files, {
        date: DATE,
      }),
    );
    expect(mimeHeader(parsed, 'In-Reply-To')).toBeNull();
    expect(mimeHeader(parsed, 'References')).toBeNull();
    expect(mimeHeader(parsed, 'Subject')).toBe('Hello');
  });

  it('refuses to send without an attachment’s bytes', async () => {
    await expect(buildMime(message({ attachments: [ATTACHMENT] }), new Map())).rejects.toThrow(
      'The attachment plan.pdf is missing',
    );
  });
});
