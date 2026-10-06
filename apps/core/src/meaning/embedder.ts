import { Worker } from 'node:worker_threads';
import type { EmbeddingModel } from './model';

/*
  An embedder turns texts into vectors. The real one runs the model in a worker thread beside the
  Core (embed-worker.ts, built next to the bundled Core), so embedding never blocks the Core's main
  thread; tests and the end-to-end tests use the fake one (fake.ts), behind the same interface.
*/

export type Embedded = { vectors: Float32Array[]; tokens: number };

export type Embedder = {
  embed(texts: readonly string[]): Promise<Embedded>;
  // Stops it and frees the model's memory.
  close(): Promise<void>;
};

export type WorkerRequest =
  | { type: 'load'; dir: string; model: EmbeddingModel }
  | { type: 'embed'; id: number; texts: string[] };

export type WorkerReply =
  | { type: 'loaded' }
  | { type: 'failed'; error: string }
  | { type: 'embedded'; id: number; vectors: Float32Array[]; tokens: number }
  | { type: 'embed-failed'; id: number; error: string };

/** The real model, from its downloaded files in `dir`, in a worker thread. Resolves once loaded. */
export function workerEmbedder(workerPath: string, dir: string, model: EmbeddingModel): Promise<Embedder> {
  const worker = new Worker(workerPath);
  let nextId = 1;
  const waiting = new Map<
    number,
    { resolve: (embedded: Embedded) => void; reject: (error: Error) => void }
  >();
  let failure: Error | null = null;

  const failAll = (error: Error) => {
    failure = error;
    for (const each of waiting.values()) each.reject(error);
    waiting.clear();
  };

  return new Promise((resolve, reject) => {
    const embedder: Embedder = {
      embed(texts) {
        if (failure) return Promise.reject(failure);
        const id = nextId++;
        return new Promise((done, fail) => {
          waiting.set(id, { resolve: done, reject: fail });
          worker.postMessage({ type: 'embed', id, texts: [...texts] } satisfies WorkerRequest);
        });
      },
      async close() {
        failAll(new Error('The embedding model was closed'));
        await worker.terminate();
      },
    };
    worker.on('message', (reply: WorkerReply) => {
      if (reply.type === 'loaded') resolve(embedder);
      else if (reply.type === 'failed') {
        reject(new Error(reply.error));
        void worker.terminate();
      } else {
        const pending = waiting.get(reply.id);
        waiting.delete(reply.id);
        if (reply.type === 'embedded') pending?.resolve({ vectors: reply.vectors, tokens: reply.tokens });
        else pending?.reject(new Error(reply.error));
      }
    });
    worker.on('error', (thrown: unknown) => {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));
      failAll(error);
      reject(error);
    });
    worker.on('exit', () => {
      const stopped = new Error('The embedding model stopped');
      if (!failure) failAll(stopped);
      reject(stopped);
    });
    worker.postMessage({ type: 'load', dir, model } satisfies WorkerRequest);
  });
}
