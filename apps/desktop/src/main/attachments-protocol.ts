// Serves pasted images to the sandboxed window as attachment://local/<name>, from the attachments
// folder next to the database and nothing else: the name must be a content hash with an image
// extension (no paths), the file a regular file inside the folder, and it is only ever read.
import { lstat, readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { attachmentFromUrl, attachmentScheme, attachmentTypes } from '@commander/domain';

/** Registered before the app is ready, so the window can load images from it like any secure page. */
export const attachmentSchemePrivileges = {
  scheme: attachmentScheme,
  privileges: { standard: true, secure: true },
};

const nothing = (status: number) => new Response(null, { status });

export async function serveAttachment(
  request: { url: string; method: string },
  dir: string,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return nothing(405);
  const name = attachmentFromUrl(request.url);
  if (!name) return nothing(404);
  const folder = resolve(dir);
  const path = join(folder, name);
  if (dirname(path) !== folder) return nothing(404);
  try {
    if (!(await lstat(path)).isFile()) return nothing(404);
    const body = await readFile(path);
    const type = attachmentTypes[extname(name).slice(1) as keyof typeof attachmentTypes];
    return new Response(request.method === 'HEAD' ? null : body, {
      headers: {
        'content-type': type,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=31536000, immutable',
      },
    });
  } catch {
    return nothing(404);
  }
}
