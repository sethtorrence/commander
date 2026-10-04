// The email reader's protocol, commander-mail: (#134). It serves the sandboxed frame its document and
// nothing else: the sanitised HTML of one prepared message, that message's remote images (fetched by
// the main process when its image rule shows them), and its inline parts (from the message's own
// parts, cached by the Core). Every URL carries the random token of one preparation (see the domain's
// email-reader.ts), so a document can reach only its own images and parts.
//
// The document's response carries its own CSP: no script, no frames, no fonts, nothing from anywhere
// but inline styles and Commander's own images, and `sandbox` (no scripts, forms, same-origin or
// top-level navigation), so even loaded outside its frame (the measurer) it runs nothing.
//
// The scheme is registered with `bypassCSP` so that the window's own CSP can stay exactly as it is
// (its `default-src 'self'` would otherwise refuse the frame). That makes the window's and the
// document's CSPs let commander-mail: URLs through, so the session's request guard (network-guard.ts)
// takes CSP's place for this scheme: a document only as a frame of the window (or the measurer's page),
// and images and parts only as images. Every response says `nosniff`, so nothing served here can run
// as a script either.
import { readFile } from 'node:fs/promises';
import { type EmailPart, type EmailRender, emailReaderScheme, emailReaderUrlOf } from '@commander/domain';
import type { RemoteImage } from './remote-images';
import { sniffImage } from './remote-images';

/** Registered before the app is ready (see the note above on bypassCSP). */
export const emailReaderSchemePrivileges = {
  scheme: emailReaderScheme,
  privileges: { standard: true, secure: true, bypassCSP: true },
};

export const DOCUMENT_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  `img-src ${emailReaderScheme}:`,
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox allow-popups allow-popups-to-escape-sandbox',
].join('; ');
// For images and parts, should one ever be opened as a document.
const RESOURCE_CSP = "default-src 'none'; sandbox";

// Inline parts the frame may show: images only (SVG among them: as an image it runs nothing).
const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
  'image/svg+xml',
]);
const INLINE_MAX_BYTES = 20 * 1024 * 1024;

export type PreparedMessage = { itemId: string; render: EmailRender };

export type EmailProtocolDeps = {
  // A preparation by its token, or null.
  prepared: (token: string) => PreparedMessage | null;
  remoteImage: (account: string, url: string) => Promise<RemoteImage | null>;
  part: (itemId: string, contentId: string) => Promise<EmailPart | null>;
  readFile?: (path: string) => Promise<Buffer>;
};

const nothing = (status: number) =>
  new Response(null, {
    status,
    headers: { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' },
  });

const image = (type: string, bytes: Buffer) =>
  // The bytes as they are, not copied (a Buffer is a Uint8Array).
  new Response(bytes as unknown as Uint8Array<ArrayBuffer>, {
    headers: {
      'content-type': type,
      'x-content-type-options': 'nosniff',
      'content-security-policy': RESOURCE_CSP,
      'cache-control': 'no-store',
      'cross-origin-resource-policy': 'same-site',
    },
  });

export async function serveEmailReader(
  request: { url: string; method: string },
  deps: EmailProtocolDeps,
): Promise<Response> {
  if (request.method !== 'GET') return nothing(405);
  const asked = emailReaderUrlOf(request.url);
  if (!asked) return nothing(404);
  const prepared = deps.prepared(asked.token);
  if (!prepared) return nothing(404);
  const { render, itemId } = prepared;

  if (asked.kind === 'message') {
    return new Response(render.html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': DOCUMENT_CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
        'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=()',
      },
    });
  }

  if (asked.kind === 'image') {
    // Only when this preparation shows remote images, and only the ones it named.
    const url = render.images === 'shown' ? render.remoteImages[asked.index] : undefined;
    if (!url) return nothing(404);
    const fetched = await deps.remoteImage(render.account, url);
    return fetched ? image(fetched.type, fetched.bytes) : nothing(404);
  }

  const part = await deps.part(itemId, asked.contentId).catch(() => null);
  if (!part || part.size > INLINE_MAX_BYTES) return nothing(404);
  const declared = part.type.split(';')[0]?.trim().toLowerCase() ?? '';
  let bytes: Buffer;
  try {
    bytes = await (deps.readFile ?? readFile)(part.path);
  } catch {
    return nothing(404);
  }
  // The bytes decide, as for remote images; SVG only as its sender declared it.
  const type = sniffImage(bytes) ?? (declared === 'image/svg+xml' ? declared : null);
  if (!type || !INLINE_TYPES.has(type)) return nothing(404);
  return image(type, bytes);
}
