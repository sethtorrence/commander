import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DownloadProgress, downloadModel, type ModelFile } from './download';

// Downloading the embedding model's files (#73) from a local server standing in for Hugging Face:
// progress as it goes, carrying on where an interrupted download stopped, and nothing kept that
// doesn't match its checksum.

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const bytes = (length: number, seed: number) =>
  Buffer.from(Array.from({ length }, (_, i) => (i * seed) % 251));

const MODEL = bytes(100_000, 7);
const TOKENIZER = bytes(20_000, 13);
const files: ModelFile[] = [
  { path: 'onnx/model.onnx', size: MODEL.length, sha256: sha256(MODEL) },
  { path: 'tokenizer.json', size: TOKENIZER.length, sha256: sha256(TOKENIZER) },
];

let dir: string;
let server: Server;
let baseUrl: string;
let served: Record<string, Buffer>;
// Requests as they came: the path and the Range asked for.
let requests: { path: string; range: string | undefined }[];
// Ends the next response for a path after this many bytes.
let cutAfter: Record<string, number>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'commander-model-'));
  served = { '/onnx/model.onnx': MODEL, '/tokenizer.json': TOKENIZER };
  requests = [];
  cutAfter = {};
  server = createServer((request, response) => {
    const path = request.url ?? '';
    requests.push({ path, range: request.headers.range });
    const body = served[path];
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    const from = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? '')?.[1] ?? 0);
    const rest = body.subarray(from);
    response.writeHead(from ? 206 : 200, { 'content-length': rest.length });
    const cut = cutAfter[path];
    if (cut !== undefined) {
      delete cutAfter[path];
      response.write(rest.subarray(0, cut), () => response.destroy());
      return;
    }
    response.end(rest);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

describe('downloading the model', () => {
  it('fetches every file into the folder, saying how far it has got', async () => {
    const progress: DownloadProgress[] = [];
    await downloadModel({ baseUrl, files, dir, onProgress: (now) => progress.push(now) });

    expect(readFileSync(join(dir, 'onnx/model.onnx')).equals(MODEL)).toBe(true);
    expect(readFileSync(join(dir, 'tokenizer.json')).equals(TOKENIZER)).toBe(true);
    expect(progress.at(-1)).toEqual({ receivedBytes: 120_000, totalBytes: 120_000 });
    const received = progress.map((now) => now.receivedBytes);
    expect(received).toEqual([...received].sort((a, b) => a - b));
  });

  it('downloads nothing again once the files are there', async () => {
    await downloadModel({ baseUrl, files, dir });
    requests = [];
    const progress: DownloadProgress[] = [];
    await downloadModel({ baseUrl, files, dir, onProgress: (now) => progress.push(now) });
    expect(requests).toEqual([]);
    expect(progress.at(-1)).toEqual({ receivedBytes: 120_000, totalBytes: 120_000 });
  });

  it('carries on from where an interrupted download stopped', async () => {
    cutAfter['/onnx/model.onnx'] = 30_000;
    await expect(downloadModel({ baseUrl, files, dir })).rejects.toThrow();
    expect(existsSync(join(dir, 'onnx/model.onnx'))).toBe(false);

    await downloadModel({ baseUrl, files, dir });
    expect(requests.filter((request) => request.path === '/onnx/model.onnx').map((r) => r.range)).toEqual([
      undefined,
      'bytes=30000-',
    ]);
    expect(readFileSync(join(dir, 'onnx/model.onnx')).equals(MODEL)).toBe(true);
  });

  it('keeps nothing that fails its checksum, and starts that file again next time', async () => {
    served['/tokenizer.json'] = bytes(20_000, 17);
    await expect(downloadModel({ baseUrl, files, dir })).rejects.toThrow(
      'tokenizer.json didn’t match its checksum',
    );
    expect(existsSync(join(dir, 'tokenizer.json'))).toBe(false);
    expect(existsSync(join(dir, 'tokenizer.json.part'))).toBe(false);

    served['/tokenizer.json'] = TOKENIZER;
    await downloadModel({ baseUrl, files, dir });
    expect(readFileSync(join(dir, 'tokenizer.json')).equals(TOKENIZER)).toBe(true);
  });

  it('starts a file again when the server ignores the resume', async () => {
    writeFileSync(join(dir, 'tokenizer.json.part'), TOKENIZER.subarray(0, 5_000));
    served['/tokenizer.json'] = TOKENIZER;
    const ignoring = server.listeners('request')[0] as (...args: unknown[]) => void;
    server.removeAllListeners('request');
    server.on('request', (request, response) => {
      delete request.headers.range;
      ignoring(request, response);
    });
    await downloadModel({ baseUrl, files, dir });
    expect(readFileSync(join(dir, 'tokenizer.json')).equals(TOKENIZER)).toBe(true);
  });

  it('stops when told to', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(downloadModel({ baseUrl, files, dir, signal: controller.signal })).rejects.toThrow();
    expect(existsSync(join(dir, 'onnx/model.onnx'))).toBe(false);
  });
});
