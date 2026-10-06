// A small reader of the MIME Commander builds (mime.ts), for the tests and the fake Gmail that check
// what a send carried: headers (unfolded, encoded words left as they are), multipart bodies split on
// their boundaries, and each leaf's bytes with its transfer encoding (base64, quoted-printable)
// undone. Not a general MIME parser: it reads well-formed messages only.

export type MimePart = {
  headers: { name: string; value: string }[];
  // The media type, lower-case ("multipart/mixed", "text/plain").
  type: string;
  params: Record<string, string>;
  // Content-Disposition's type and filename, when it has one.
  disposition: string | null;
  filename: string | null;
  // A leaf's decoded bytes (empty for a multipart).
  body: Buffer;
  parts: MimePart[];
};

function headerParams(value: string): { main: string; params: Record<string, string> } {
  const [main = '', ...rest] = value.split(';');
  const params: Record<string, string> = {};
  for (const each of rest) {
    const equals = each.indexOf('=');
    if (equals < 0) continue;
    const name = each.slice(0, equals).trim().toLowerCase();
    params[name] = each
      .slice(equals + 1)
      .trim()
      .replace(/^"(.*)"$/s, '$1');
  }
  return { main: main.trim().toLowerCase(), params };
}

function decodeQuotedPrintable(text: string): Buffer {
  const joined = text.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const char = joined[i] as string;
    if (char === '=' && /^[0-9A-F]{2}$/i.test(joined.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...Buffer.from(char, 'utf8'));
  }
  return Buffer.from(bytes);
}

/** A message (or part) as raw MIME, read into its headers and parts. */
export function parseMime(raw: Buffer | string): MimePart {
  const text = Buffer.isBuffer(raw) ? raw.toString('latin1') : raw;
  const split = text.search(/\r?\n\r?\n/);
  const head = split < 0 ? text : text.slice(0, split);
  const rest = split < 0 ? '' : text.slice(split).replace(/^\r?\n\r?\n/, '');
  const headers = head
    .replace(/\r?\n[ \t]+/g, ' ')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const colon = line.indexOf(':');
      return { name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() };
    });
  const header = (name: string) =>
    headers.find((each) => each.name.toLowerCase() === name.toLowerCase())?.value ?? null;
  const { main: type, params } = headerParams(header('Content-Type') ?? 'text/plain');
  const disposition = header('Content-Disposition');
  const dispositionParams = disposition ? headerParams(disposition) : null;
  const filename = dispositionParams?.params.filename ?? params.name ?? null;
  const base = {
    headers,
    type,
    params,
    disposition: dispositionParams?.main ?? null,
    filename,
  };
  if (type.startsWith('multipart/') && params.boundary) {
    const delimiter = `--${params.boundary}`;
    const pieces = rest.split(new RegExp(`\\r?\\n?${delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const parts = pieces
      .slice(1)
      .filter((piece) => !piece.startsWith('--'))
      .map((piece) => parseMime(piece.replace(/^\r?\n/, '')));
    return { ...base, body: Buffer.alloc(0), parts };
  }
  const encoding = (header('Content-Transfer-Encoding') ?? '7bit').toLowerCase();
  let body: Buffer;
  if (encoding === 'base64') body = Buffer.from(rest.replace(/\s+/g, ''), 'base64');
  else if (encoding === 'quoted-printable') body = decodeQuotedPrintable(rest);
  else body = Buffer.from(rest, 'latin1');
  return { ...base, body, parts: [] };
}

/** A header's value in a part, or null. */
export const mimeHeader = (part: MimePart, name: string) =>
  part.headers.find((each) => each.name.toLowerCase() === name.toLowerCase())?.value ?? null;

/** Every leaf part, depth first. */
export function mimeLeaves(part: MimePart): MimePart[] {
  return part.parts.length ? part.parts.flatMap(mimeLeaves) : [part];
}
