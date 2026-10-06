import { createHash, type Hash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

/*
  Downloading the embedding model's files (#73) into Commander's data folder, once. Each file is
  fetched into `<file>.part`, carrying on from where an interrupted download stopped (an HTTP Range
  request), and only renamed into place once its size and SHA-256 match the pinned ones, so a file
  in place is always whole and the one that was meant. Only the files are fetched: nothing is sent.
*/

export type ModelFile = { path: string; size: number; sha256: string };
export type DownloadProgress = { receivedBytes: number; totalBytes: number };

export class DownloadError extends Error {
  override name = 'DownloadError';
}

async function hashOf(path: string, hash: Hash): Promise<void> {
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
}

const sizeOf = (path: string) => (existsSync(path) ? statSync(path).size : 0);

/** Whether every file is in place (a file is only put in place once checked). */
export const modelDownloaded = (dir: string, files: readonly ModelFile[]) =>
  files.every((file) => sizeOf(join(dir, file.path)) === file.size);

export async function downloadModel({
  baseUrl,
  files,
  dir,
  onProgress,
  signal,
}: {
  // Where the files are: `${baseUrl}/${file.path}`.
  baseUrl: string;
  files: readonly ModelFile[];
  dir: string;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const done = new Map(files.map((file) => [file.path, 0]));
  const report = () =>
    onProgress?.({ receivedBytes: [...done.values()].reduce((sum, n) => sum + n, 0), totalBytes });

  for (const file of files) {
    const target = join(dir, file.path);
    if (sizeOf(target) === file.size) done.set(file.path, file.size);
  }
  report();

  for (const file of files) {
    if (done.get(file.path) === file.size) continue;
    signal?.throwIfAborted();
    const target = join(dir, file.path);
    const part = `${target}.part`;
    mkdirSync(dirname(target), { recursive: true });
    let have = sizeOf(part);
    if (have > file.size) {
      rmSync(part);
      have = 0;
    }
    const response = await fetch(`${baseUrl}/${file.path}`, {
      headers: have ? { range: `bytes=${have}-` } : {},
      signal,
    });
    if (!response.ok || !response.body) {
      throw new DownloadError(`Couldn’t download ${file.path}: the server answered ${response.status}`);
    }
    // A server that ignores the Range sends the whole file: start it again.
    if (have && response.status !== 206) {
      rmSync(part);
      have = 0;
    }
    const hash = createHash('sha256');
    if (have) await hashOf(part, hash);
    done.set(file.path, have);
    report();

    const out = createWriteStream(part, { flags: have ? 'a' : 'w' });
    try {
      for await (const chunk of Readable.fromWeb(response.body as never)) {
        const bytes = chunk as Buffer;
        hash.update(bytes);
        if (!out.write(bytes)) await new Promise((resolve) => out.once('drain', resolve));
        done.set(file.path, (done.get(file.path) ?? 0) + bytes.length);
        report();
      }
    } finally {
      out.end();
      await finished(out).catch(() => {});
    }

    if (sizeOf(part) !== file.size || hash.digest('hex') !== file.sha256) {
      rmSync(part, { force: true });
      done.set(file.path, 0);
      throw new DownloadError(`${file.path} didn’t match its checksum, so it was thrown away`);
    }
    renameSync(part, target);
  }
}
