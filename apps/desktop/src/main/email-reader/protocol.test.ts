import { type EmailRender, emailImageUrl, emailMessageUrl, emailPartUrl } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_CSP,
  type EmailProtocolDeps,
  emailReaderSchemePrivileges,
  serveEmailReader,
} from './protocol';

const TOKEN = 'cd'.repeat(16);
const OTHER = 'ef'.repeat(16);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

const render = (overrides: Partial<EmailRender> = {}): EmailRender => ({
  html: '<!doctype html><p>hi</p>',
  remoteImages: ['https://cdn.test/a.png'],
  images: 'shown',
  imageCount: 1,
  hasQuote: false,
  account: 'google:1',
  sender: 'a@b.test',
  ...overrides,
});

function deps(overrides: Partial<EmailProtocolDeps> & { renderAs?: EmailRender } = {}) {
  const asked: string[] = [];
  const result: EmailProtocolDeps = {
    prepared: (token) =>
      token === TOKEN ? { itemId: 'item-1', render: overrides.renderAs ?? render() } : null,
    remoteImage: async (account, url) => {
      asked.push(`${account} ${url}`);
      return { type: 'image/png', bytes: PNG };
    },
    part: async (itemId, contentId) =>
      itemId === 'item-1' && contentId === 'logo@x'
        ? { path: '/cache/logo.png', name: 'logo.png', type: 'image/png', size: PNG.length }
        : null,
    readFile: async () => PNG,
    ...overrides,
  };
  return { deps: result, asked };
}

const get = (url: string, given = deps().deps) => serveEmailReader({ url, method: 'GET' }, given);

describe('the commander-mail: protocol', () => {
  it('is a standard, secure scheme that the window’s CSP doesn’t have to name', () => {
    expect(emailReaderSchemePrivileges).toEqual({
      scheme: 'commander-mail',
      privileges: { standard: true, secure: true, bypassCSP: true },
    });
  });

  it('serves a prepared message’s document with a CSP of its own that runs and loads nothing', async () => {
    const response = await get(emailMessageUrl(TOKEN));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<!doctype html><p>hi</p>');
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const csp = response.headers.get('content-security-policy');
    expect(csp).toBe(DOCUMENT_CSP);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('sandbox allow-popups allow-popups-to-escape-sandbox');
    expect(csp).not.toMatch(/script-src|allow-scripts|allow-same-origin|allow-forms|unsafe-eval|https?:/);
  });

  it('serves nothing for an unknown token, another form, or another method', async () => {
    expect((await get(emailMessageUrl(OTHER))).status).toBe(404);
    expect((await get(`${emailMessageUrl(TOKEN)}?x`)).status).toBe(404);
    expect((await get('commander-mail://message/../etc')).status).toBe(404);
    expect(
      (await serveEmailReader({ url: emailMessageUrl(TOKEN), method: 'POST' }, deps().deps)).status,
    ).toBe(405);
  });

  it('fetches a remote image the preparation named, only while its images are shown', async () => {
    const shown = deps();
    const response = await get(emailImageUrl(TOKEN, 0), shown.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(shown.asked).toEqual(['google:1 https://cdn.test/a.png']);
    expect((await get(emailImageUrl(TOKEN, 1), shown.deps)).status).toBe(404);

    const held = deps({ renderAs: render({ images: 'held', remoteImages: ['https://cdn.test/a.png'] }) });
    expect((await get(emailImageUrl(TOKEN, 0), held.deps)).status).toBe(404);
    expect(held.asked).toEqual([]);
  });

  it('serves the message’s own inline images, judged by their bytes', async () => {
    const response = await get(emailPartUrl(TOKEN, 'logo@x'));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    expect((await get(emailPartUrl(TOKEN, 'other@x'))).status).toBe(404);
    const html = deps({ readFile: async () => Buffer.from('<script>alert(1)</script>') });
    expect((await get(emailPartUrl(TOKEN, 'logo@x'), html.deps)).status).toBe(404);
    const pdf = deps({
      part: async () => ({ path: '/x.pdf', name: 'x.pdf', type: 'application/pdf', size: 10 }),
      readFile: async () => Buffer.from('%PDF-1.7'),
    });
    expect((await get(emailPartUrl(TOKEN, 'logo@x'), pdf.deps)).status).toBe(404);
  });
});
