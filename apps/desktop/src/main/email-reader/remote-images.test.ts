import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRemoteImages, fetchRemoteImage, isPublicAddress, sniffImage } from './remote-images';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const GIF = Buffer.from('GIF89a\u0001\u0000', 'latin1');

describe('which addresses remote images may come from', () => {
  it('allows the public internet', () => {
    for (const address of [
      '93.184.216.34',
      '8.8.8.8',
      '2606:2800:220:1:248:1893:25c8:1946',
      '::ffff:8.8.8.8',
    ])
      expect(isPublicAddress(address), address).toBe(true);
  });

  it('refuses this machine, the local network, and reserved ranges, however they are written', () => {
    for (const address of [
      '127.0.0.1',
      '127.255.255.254',
      '0.0.0.0',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '198.18.0.1',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:192.168.0.1',
      '::ffff:0:10.0.0.1',
      '64:ff9b::7f00:1',
      '64:ff9b::10.0.0.1',
      '::127.0.0.1',
      '2002:7f00:1::1',
      '2001:0:4136:e378::1',
      'not an address',
      'localhost',
    ])
      expect(isPublicAddress(address), address).toBe(false);
  });
});

describe('sniffing images', () => {
  it('knows the image types email uses by their first bytes', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(GIF)).toBe('image/gif');
    expect(sniffImage(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1'))).toBe('image/webp');
    expect(sniffImage(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniffImage(Buffer.from('%PDF-1.7'))).toBeNull();
  });
});

describe('fetching a remote image', () => {
  let server: Server;
  let base: string;
  let hits: { url: string; headers: Record<string, unknown> }[];
  const loopbackAllowed = { allowAddress: () => true };

  beforeEach(async () => {
    hits = [];
    server = createServer((request, response) => {
      hits.push({ url: request.url ?? '', headers: request.headers });
      const route = request.url ?? '';
      if (route === '/pixel.png') return response.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
      if (route === '/mislabelled')
        return response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(GIF);
      if (route === '/page')
        return response.writeHead(200, { 'content-type': 'image/png' }).end('<script>x</script>');
      if (route === '/icon.svg')
        return response.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg/>');
      if (route === '/big')
        return response.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.alloc(2048, 1));
      if (route === '/redirect') return response.writeHead(302, { location: '/pixel.png' }).end();
      if (route === '/loop') return response.writeHead(302, { location: '/loop' }).end();
      if (route === '/to-file') return response.writeHead(302, { location: 'file:///etc/passwd' }).end();
      if (route === '/slow') return setTimeout(() => response.end(PNG), 2000);
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('fetches an image with no cookies, referrer or compression', async () => {
    const image = await fetchRemoteImage(`${base}/pixel.png`, loopbackAllowed);
    expect(image).toEqual({ type: 'image/png', bytes: PNG });
    const [hit] = hits;
    expect(hit?.headers.cookie).toBeUndefined();
    expect(hit?.headers.referer).toBeUndefined();
    expect(hit?.headers['accept-encoding']).toBe('identity');
  });

  it('never reaches this machine or the local network', async () => {
    expect(await fetchRemoteImage(`${base}/pixel.png`)).toBeNull();
    expect(await fetchRemoteImage(`http://localhost:${new URL(base).port}/pixel.png`)).toBeNull();
    expect(await fetchRemoteImage(`http://[::1]:${new URL(base).port}/pixel.png`)).toBeNull();
    expect(hits).toEqual([]);
  });

  it('refuses a name that resolves to a private address', async () => {
    const lookup = ((_host: string, _options: object, callback: (e: null, a: unknown[]) => void) =>
      callback(null, [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ])) as never;
    expect(
      await fetchRemoteImage(`http://rebind.test:${new URL(base).port}/pixel.png`, { lookup }),
    ).toBeNull();
    expect(hits).toEqual([]);
  });

  it('decides the type by the bytes, and turns away what isn’t an image', async () => {
    expect((await fetchRemoteImage(`${base}/mislabelled`, loopbackAllowed))?.type).toBe('image/gif');
    expect(await fetchRemoteImage(`${base}/page`, loopbackAllowed)).toBeNull();
    expect((await fetchRemoteImage(`${base}/icon.svg`, loopbackAllowed))?.type).toBe('image/svg+xml');
    expect(await fetchRemoteImage(`${base}/missing`, loopbackAllowed)).toBeNull();
  });

  it('follows a few redirects, only to the web', async () => {
    expect((await fetchRemoteImage(`${base}/redirect`, loopbackAllowed))?.type).toBe('image/png');
    expect(await fetchRemoteImage(`${base}/loop`, loopbackAllowed)).toBeNull();
    expect(hits.filter((hit) => hit.url === '/loop')).toHaveLength(4);
    expect(await fetchRemoteImage(`${base}/to-file`, loopbackAllowed)).toBeNull();
  });

  it('gives up on an image too large or too slow', async () => {
    expect(await fetchRemoteImage(`${base}/big`, { ...loopbackAllowed, maxBytes: 1024 })).toBeNull();
    expect(await fetchRemoteImage(`${base}/slow`, { ...loopbackAllowed, timeoutMs: 200 })).toBeNull();
  });

  it('refuses anything but http(s), and credentials in the URL', async () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://x.test/a.png',
      `http://user:pass@127.0.0.1/x`,
      'not a url',
    ])
      expect(await fetchRemoteImage(url, loopbackAllowed), url).toBeNull();
  });
});

describe('the remote image cache', () => {
  it('fetches each image once per Account, sharing a fetch under way, and forgets an Account', async () => {
    const asked: string[] = [];
    const images = createRemoteImages({
      fetch: async (url) => {
        asked.push(url);
        return { type: 'image/png', bytes: PNG };
      },
    });
    const [a, b] = await Promise.all([
      images.get('acct', 'https://x.test/a'),
      images.get('acct', 'https://x.test/a'),
    ]);
    expect(a).toEqual(b);
    await images.get('acct', 'https://x.test/a');
    expect(asked).toEqual(['https://x.test/a']);
    images.forget('acct');
    await images.get('acct', 'https://x.test/a');
    expect(asked).toHaveLength(2);
  });

  it('fetches at most a few at a time, however many a message names', async () => {
    let running = 0;
    let most = 0;
    const images = createRemoteImages({
      fetch: async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return { type: 'image/png', bytes: PNG };
      },
    });
    await Promise.all(Array.from({ length: 500 }, (_, i) => images.get('a', `https://x.test/${i}`)));
    expect(most).toBe(6);
  });

  it('keeps no more than its budget', async () => {
    let fetches = 0;
    const images = createRemoteImages({
      fetch: async () => {
        fetches += 1;
        return { type: 'image/png', bytes: Buffer.alloc(600) };
      },
      maxCachedBytes: 1000,
    });
    await images.get('a', 'https://x.test/1');
    await images.get('a', 'https://x.test/2');
    await images.get('a', 'https://x.test/1');
    expect(fetches).toBe(3);
  });
});
