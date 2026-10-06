// The embedding model's worker thread (#73): runs granite (model.ts) through onnxruntime-node, one
// batch of texts at a time, so embedding never blocks the Core's main thread. It lowers its own
// priority first (on Linux this is per thread, and the runtime's threads, started after, inherit
// it), so a backfill gives way to everything else on the machine. Built as its own file next to the
// bundled Core (see electron.vite.config.ts). It reads only the downloaded files and sends nothing.
import { readFileSync } from 'node:fs';
import { setPriority } from 'node:os';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { Tokenizer } from '@huggingface/tokenizers';
import { InferenceSession, Tensor } from 'onnxruntime-node';
import type { WorkerReply, WorkerRequest } from './embedder';
import type { EmbeddingModel } from './model';

// Low priority: 19 is the lowest.
const NICE = 19;
// The runtime's threads: enough to embed a query quickly, few enough to leave the machine alone.
const THREADS = 2;

let model: EmbeddingModel | null = null;
let tokenizer: Tokenizer | null = null;
let session: InferenceSession | null = null;
let padId = 0;
let sepId: number | null = null;

const send = (reply: WorkerReply, transfer: ArrayBuffer[] = []) => parentPort?.postMessage(reply, transfer);

async function load(dir: string, chosen: EmbeddingModel) {
  try {
    setPriority(NICE);
  } catch {
    // Not allowed here: carry on at normal priority.
  }
  const config = JSON.parse(readFileSync(join(dir, chosen.tokenizerConfig), 'utf8')) as Record<
    string,
    unknown
  >;
  const json = JSON.parse(readFileSync(join(dir, chosen.tokenizer), 'utf8')) as {
    padding?: { pad_id?: number } | null;
    post_processor?: { special_tokens?: Record<string, { ids?: number[] }> } | null;
  };
  tokenizer = new Tokenizer(json, config);
  padId = json.padding?.pad_id ?? 0;
  const sep = config.sep_token;
  sepId = typeof sep === 'string' ? (tokenizer.token_to_id(sep) ?? null) : null;
  session = await InferenceSession.create(join(dir, chosen.onnx), {
    intraOpNumThreads: THREADS,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
    enableCpuMemArena: false,
  });
  model = chosen;
}

async function embed(texts: string[]): Promise<{ vectors: Float32Array[]; tokens: number }> {
  if (!model || !tokenizer || !session) throw new Error('The embedding model isn’t loaded');
  const max = model.maxTokens;
  const encoded = texts.map((text) => {
    const ids = tokenizer?.encode(text).ids ?? [];
    // Cut to the model's length, keeping the closing separator.
    return ids.length <= max ? ids : [...ids.slice(0, max - 1), ...(sepId === null ? [] : [sepId])];
  });
  const length = Math.max(1, ...encoded.map((ids) => ids.length));
  const ids = new BigInt64Array(texts.length * length).fill(BigInt(padId));
  const mask = new BigInt64Array(texts.length * length);
  encoded.forEach((each, row) => {
    each.forEach((id, column) => {
      ids[row * length + column] = BigInt(id);
      mask[row * length + column] = 1n;
    });
  });
  const output = await session.run({
    input_ids: new Tensor('int64', ids, [texts.length, length]),
    attention_mask: new Tensor('int64', mask, [texts.length, length]),
  });
  const hidden = output.last_hidden_state ?? Object.values(output)[0];
  if (!hidden) throw new Error('The embedding model gave no output');
  const data = hidden.data as Float32Array;
  const width = hidden.dims[2] ?? model.dimensions;
  // CLS pooling (the first token's state), normalised to length 1.
  const vectors = texts.map((_, row) => {
    const start = row * length * width;
    const vector = Float32Array.from(data.subarray(start, start + width));
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] as number) / norm;
    return vector;
  });
  return { vectors, tokens: encoded.reduce((sum, each) => sum + each.length, 0) };
}

// One request at a time, in order.
let queue = Promise.resolve();
parentPort?.on('message', (request: WorkerRequest) => {
  queue = queue.then(async () => {
    if (request.type === 'load') {
      try {
        await load(request.dir, request.model);
        send({ type: 'loaded' });
      } catch (error) {
        send({ type: 'failed', error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    try {
      const { vectors, tokens } = await embed(request.texts);
      send(
        { type: 'embedded', id: request.id, vectors, tokens },
        vectors.map((vector) => vector.buffer as ArrayBuffer),
      );
    } catch (error) {
      send({
        type: 'embed-failed',
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
});
