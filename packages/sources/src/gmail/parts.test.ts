import { describe, expect, it } from 'vitest';
import { type AccessToken, PartNotFound, PartTooLarge, SignInRefused } from '../source';
import { createGmailSource } from './gmail-source';

// The reader's parts (#134) through the Gmail adapter: the message is read again for its current
// structure (Gmail's attachment ids aren't stable between fetches), then the part's bytes come from
// the message itself (small parts) or from `messages.attachments.get`.

const GMAIL = 'https://gmail.test';
const token: AccessToken = { token: 'ya29.test', kind: 'oauth' };
const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64url');
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF = Buffer.from('%PDF-1.7 tiny');

const message = {
  id: 'm1',
  threadId: 't1',
  payload: {
    partId: '',
    mimeType: 'multipart/mixed',
    parts: [
      {
        partId: '0',
        mimeType: 'multipart/related',
        parts: [
          {
            partId: '0.0',
            mimeType: 'text/html',
            body: { size: 30, data: b64('<img src="cid:logo@shop">') },
          },
          {
            partId: '0.1',
            mimeType: 'image/png',
            filename: 'logo.png',
            headers: [{ name: 'Content-ID', value: '<Logo@Shop>' }],
            body: { size: PNG.length, attachmentId: 'ATT-logo-fresh' },
          },
          {
            partId: '0.2',
            mimeType: 'image/gif',
            filename: '',
            headers: [{ name: 'Content-ID', value: '<dot>' }],
            body: { size: 3, data: b64('GIF') },
          },
        ],
      },
      {
        partId: '1',
        mimeType: 'application/pdf',
        filename: 'Agenda.pdf',
        headers: [{ name: 'Content-Disposition', value: 'attachment; filename="Agenda.pdf"' }],
        body: { size: PDF.length, attachmentId: 'ATT-pdf' },
      },
      {
        partId: '2',
        mimeType: 'application/zip',
        filename: 'big.zip',
        body: { size: 50_000_000, attachmentId: 'ATT-big' },
      },
    ],
  },
};

function fakeGmail(overrides: Record<string, Response> = {}) {
  const paths: string[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).slice(GMAIL.length);
    paths.push(path);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ya29.test');
    if (overrides[path]) return overrides[path];
    if (path === '/gmail/v1/users/me/messages/m1?format=full') return Response.json(message);
    if (path === '/gmail/v1/users/me/messages/m1/attachments/ATT-logo-fresh')
      return Response.json({ size: PNG.length, data: b64(PNG) });
    if (path === '/gmail/v1/users/me/messages/m1/attachments/ATT-pdf')
      return Response.json({ size: PDF.length, data: b64(PDF) });
    return Response.json({ error: { code: 404, status: 'NOT_FOUND' } }, { status: 404 });
  };
  const source = createGmailSource({ gmailUrl: () => GMAIL, fetch, sleep: async () => {} });
  const fetchPart = (part: { partId: string } | { contentId: string }, maxBytes = 35_000_000) => {
    if (!source.fetchPart) throw new Error('no fetchPart');
    return source.fetchPart({
      account: 'google:1',
      externalId: 'm1',
      part,
      maxBytes,
      accessToken: async () => token,
      signal: new AbortController().signal,
    });
  };
  return { paths, fetchPart };
}

describe('fetching a message part from Gmail', () => {
  it('fetches an inline image by its Content-ID, whatever its case, through attachments.get', async () => {
    const gmail = fakeGmail();
    const part = await gmail.fetchPart({ contentId: 'logo@shop' });
    expect(part).toEqual({ partId: '0.1', name: 'logo.png', type: 'image/png', bytes: PNG });
    expect(gmail.paths).toEqual([
      '/gmail/v1/users/me/messages/m1?format=full',
      '/gmail/v1/users/me/messages/m1/attachments/ATT-logo-fresh',
    ]);
  });

  it('takes a small part’s bytes from the message itself', async () => {
    const gmail = fakeGmail();
    const part = await gmail.fetchPart({ contentId: '<DOT>' });
    expect(Buffer.from(part.bytes).toString()).toBe('GIF');
    expect(part.name).toBe('attachment');
    expect(gmail.paths).toHaveLength(1);
  });

  it('fetches an attachment by its part id', async () => {
    const part = await fakeGmail().fetchPart({ partId: '1' });
    expect(part).toEqual({
      partId: '1',
      name: 'Agenda.pdf',
      type: 'application/pdf',
      bytes: Uint8Array.from(PDF),
    });
  });

  it('refuses a part larger than allowed before downloading it', async () => {
    const gmail = fakeGmail();
    await expect(gmail.fetchPart({ partId: '2' })).rejects.toBeInstanceOf(PartTooLarge);
    expect(gmail.paths).toEqual(['/gmail/v1/users/me/messages/m1?format=full']);
  });

  it('says when the part, or the message, is not there', async () => {
    await expect(fakeGmail().fetchPart({ contentId: 'nope' })).rejects.toBeInstanceOf(PartNotFound);
    await expect(fakeGmail().fetchPart({ partId: '0' })).rejects.toBeInstanceOf(PartNotFound);
    const gone = fakeGmail({
      '/gmail/v1/users/me/messages/m1?format=full': Response.json({ error: { code: 404 } }, { status: 404 }),
    });
    await expect(gone.fetchPart({ partId: '1' })).rejects.toBeInstanceOf(PartNotFound);
  });

  it('passes on a refused sign-in', async () => {
    const refused = fakeGmail({
      '/gmail/v1/users/me/messages/m1?format=full': Response.json({ error: { code: 401 } }, { status: 401 }),
    });
    await expect(refused.fetchPart({ partId: '1' })).rejects.toBeInstanceOf(SignInRefused);
  });
});
