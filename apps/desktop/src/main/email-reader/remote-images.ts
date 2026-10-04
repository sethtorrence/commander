// Remote images for the email reader (#134), fetched by the main process when a message's image rule
// allows them, so the sandboxed frame never touches the network itself. Commander has no proxy (as
// Gmail does), so the sender's server sees the request; everything else about it is held back:
//
// - only http(s), no credentials in the URL, no cookies, no referrer, no compression to unpack, a
//   plain Accept and User-Agent;
// - never to this machine or the local network (loopback, private, link-local, carrier-grade NAT,
//   multicast, reserved, and IPv6 forms that embed such an address): the address is checked after
//   resolving, and the connection is pinned to the checked address, so a name can't resolve to a
//   public address for the check and a private one for the request;
// - redirects followed by hand (at most 3), each checked the same way;
// - an image only: decided by its first bytes (PNG, JPEG, GIF, WebP, BMP, ICO, AVIF), or SVG when
//   the server says so (shown only as an image, where it can't run script); at most 5 MB, within 15
//   seconds; at most 6 at a time (a message can name 500), so memory stays bounded.
//
// What came back is kept in memory for a while (by Account and URL), so the frame and the measurer
// asking for the same image fetch it once; removing the Account forgets its images.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

export type RemoteImage = { type: string; bytes: Buffer };

export type RemoteImageOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  // Whether an address may be connected to (public addresses only, unless tests say otherwise).
  allowAddress?: (address: string) => boolean;
  lookup?: typeof dnsLookup;
};

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::', 96], // IPv4-compatible
  ['100::', 64],
  ['2001::', 32], // Teredo
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(network, prefix, 'ipv6');

/** Whether an address is on the public internet (not this machine, the local network or reserved). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family !== 6) return false;
  const lower = address.toLowerCase();
  // An IPv4 address mapped or translated into IPv6 is judged as that IPv4 address.
  const embedded = /^(?:::ffff:(?:0:)?|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (embedded) return isPublicAddress(embedded);
  const hex = /^(?:::ffff:(?:0:)?|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const high = Number.parseInt(hex[1] as string, 16);
    const low = Number.parseInt(hex[2] as string, 16);
    return isPublicAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  if (lower.startsWith('64:ff9b:')) return false;
  return !blocked.check(address, 'ipv6');
}

const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/avif',
  'image/svg+xml',
]);

/** An image's type from its first bytes, or null when they aren't an image Commander shows. */
export function sniffImage(bytes: Buffer): string | null {
  const starts = (...values: number[]) => values.every((value, i) => bytes[i] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (
    bytes
      .subarray(0, 6)
      .toString('latin1')
      .match(/^GIF8[79]a$/)
  )
    return 'image/gif';
  if (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  if (starts(0x42, 0x4d)) return 'image/bmp';
  if (starts(0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
  if (
    bytes.subarray(4, 8).toString('latin1') === 'ftyp' &&
    /^avi[fs]$/.test(bytes.subarray(8, 12).toString('latin1'))
  )
    return 'image/avif';
  return null;
}

const declaredType = (response: IncomingMessage) =>
  (String(response.headers['content-type'] ?? '').split(';')[0] ?? '').trim().toLowerCase();

class Refused extends Error {
  override name = 'Refused';
}

/**
 * Fetches a remote image as described above. Null when it isn't allowed, isn't there, isn't an image,
 * is too large or too slow: the frame then shows nothing in its place.
 */
export async function fetchRemoteImage(
  raw: string,
  options: RemoteImageOptions = {},
): Promise<RemoteImage | null> {
  const {
    timeoutMs = 15_000,
    maxBytes = 5 * 1024 * 1024,
    maxRedirects = 3,
    allowAddress = isPublicAddress,
    lookup = dnsLookup,
  } = options;
  const deadline = AbortSignal.timeout(timeoutMs);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
    // A literal address is never looked up, so it is checked here.
    if (isIP(host) && !allowAddress(host)) return null;
    // Resolves the name, refusing it if any of its addresses isn't allowed, and pins the connection
    // to the first one.
    const pinnedLookup = (
      hostname: string,
      lookupOptions: object,
      callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void,
    ) => {
      lookup(hostname, { ...lookupOptions, all: true }, (error, addresses: LookupAddress[]) => {
        if (error) return callback(error, '');
        if (!addresses.length || addresses.some((each) => !allowAddress(each.address)))
          return callback(new Refused(`${hostname} is not on the public internet`), '');
        const [first] = addresses as [LookupAddress];
        if ((lookupOptions as { all?: boolean }).all) return callback(null, [first]);
        callback(null, first.address, first.family);
      });
    };
    let response: IncomingMessage;
    try {
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
          url,
          {
            method: 'GET',
            lookup: pinnedLookup as never,
            signal: deadline,
            headers: {
              accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8',
              'user-agent': 'Mozilla/5.0 (compatible; Commander)',
              'accept-encoding': 'identity',
            },
          },
          resolve,
        );
        request.on('error', reject);
        request.end();
      });
    } catch {
      return null;
    }
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      response.resume();
      const location = response.headers.location;
      if (!location) return null;
      try {
        url = new URL(location, url);
      } catch {
        return null;
      }
      continue;
    }
    if (status !== 200) {
      response.resume();
      return null;
    }
    const length = Number(response.headers['content-length'] ?? 0);
    if (length > maxBytes) {
      response.destroy();
      return null;
    }
    const declared = declaredType(response);
    let bytes: Buffer;
    try {
      bytes = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy();
            reject(new Refused('too large'));
          } else chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      });
    } catch {
      return null;
    }
    const sniffed = sniffImage(bytes);
    if (sniffed) return { type: sniffed, bytes };
    if (declared === 'image/svg+xml' && IMAGE_TYPES.has(declared)) return { type: declared, bytes };
    return null;
  }
  return null;
}

type Entry = { account: string; image: RemoteImage | null; at: number; size: number };

/**
 * Remote images by Account and URL, fetched once (a frame and the measurer asking together share one
 * fetch), at most `concurrency` at a time (so at most that many 5 MB bodies are held while fetching),
 * and kept in memory for half an hour, up to 64 MB, oldest out first.
 */
export function createRemoteImages({
  fetch = fetchRemoteImage,
  now = Date.now,
  ttlMs = 30 * 60_000,
  maxCachedBytes = 64 * 1024 * 1024,
  concurrency = 6,
}: {
  fetch?: (url: string) => Promise<RemoteImage | null>;
  now?: () => number;
  ttlMs?: number;
  maxCachedBytes?: number;
  concurrency?: number;
} = {}) {
  let active = 0;
  const waiting: (() => void)[] = [];
  const limited = async (url: string) => {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await fetch(url);
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
  const cache = new Map<string, Entry>();
  const running = new Map<string, Promise<RemoteImage | null>>();
  let cachedBytes = 0;
  // Bumped when an Account is forgotten, so a fetch under way then isn't kept.
  const generations = new Map<string, number>();
  const keyOf = (account: string, url: string) => `${account}\u0000${url}`;
  const drop = (key: string) => {
    const entry = cache.get(key);
    if (!entry) return;
    cachedBytes -= entry.size;
    cache.delete(key);
  };

  return {
    get(account: string, url: string): Promise<RemoteImage | null> {
      const key = keyOf(account, url);
      const entry = cache.get(key);
      if (entry && now() - entry.at < ttlMs) return Promise.resolve(entry.image);
      drop(key);
      const pending = running.get(key);
      if (pending) return pending;
      const generation = generations.get(account) ?? 0;
      const job = limited(url)
        .catch(() => null)
        .then((image) => {
          running.delete(key);
          if ((generations.get(account) ?? 0) !== generation) return image;
          const size = image?.bytes.length ?? 0;
          cache.set(key, { account, image, at: now(), size });
          cachedBytes += size;
          for (const old of cache.keys()) {
            if (cachedBytes <= maxCachedBytes) break;
            drop(old);
          }
          return image;
        });
      running.set(key, job);
      return job;
    },

    // The Account was removed: its images go.
    forget(account: string) {
      generations.set(account, (generations.get(account) ?? 0) + 1);
      for (const key of [...running.keys()]) if (key.startsWith(`${account}\u0000`)) running.delete(key);
      for (const [key, entry] of [...cache]) if (entry.account === account) drop(key);
    },
  };
}

export type RemoteImages = ReturnType<typeof createRemoteImages>;
