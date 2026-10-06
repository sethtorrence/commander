import type { Embedder } from './embedder';
import type { EmbeddingModel } from './model';

/*
  A stand-in for the embedding model, for tests and the end-to-end tests (`--embeddings=fake`), so
  nothing is ever downloaded there. Deterministic: each word counts towards one direction, and words
  of a few small families of meaning share theirs ("rate", "limiter", "throttle" and "bursts" all
  point one way), so a query sharing no words with an Item can still find it, as with the real model.
*/

const DIMENSIONS = 64;

// Families of words that mean nearly the same, each its own direction.
const FAMILIES = [
  ['rate', 'limit', 'limits', 'limiter', 'limiting', 'throttle', 'throttling', 'burst', 'bursts', 'backoff'],
  ['contract', 'contracts', 'redline', 'redlines', 'agreement', 'legal', 'nda'],
  ['pager', 'rota', 'oncall', 'on-call', 'call', 'shift', 'shifts'],
  ['passport', 'visa', 'travel', 'trip', 'flight'],
];

const STOPWORDS = new Set('a an and are for in is it of on or the thing this that to with'.split(' '));

export const FAKE_MODEL: EmbeddingModel = {
  id: 'fake-embeddings-1',
  name: 'Stand-in embeddings (tests)',
  baseUrl: 'http://127.0.0.1:9',
  files: [],
  onnx: '',
  tokenizer: '',
  tokenizerConfig: '',
  dimensions: DIMENSIONS,
  maxTokens: 512,
  minSimilarity: 0.5,
};

function directionOf(word: string): number {
  const family = FAMILIES.findIndex((words) => words.includes(word));
  if (family >= 0) return family;
  let hash = 0;
  for (const char of word) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return FAMILIES.length + (hash % (DIMENSIONS - FAMILIES.length));
}

/** The stand-in's embedding of a text. */
export function fakeEmbedding(text: string): Float32Array {
  const vector = new Float32Array(DIMENSIONS);
  const words = (text.toLowerCase().match(/[\p{L}\p{N}-]+/gu) ?? []).filter((word) => !STOPWORDS.has(word));
  for (const word of words) {
    const at = directionOf(word);
    vector[at] = (vector[at] as number) + 1;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return vector.map((value) => value / norm);
}

export function fakeEmbedder(): Embedder {
  let closed = false;
  return {
    async embed(texts) {
      if (closed) throw new Error('The embedding model was closed');
      return {
        vectors: texts.map(fakeEmbedding),
        tokens: texts.reduce((sum, text) => sum + text.split(/\s+/).filter(Boolean).length, 0),
      };
    },
    async close() {
      closed = true;
    },
  };
}
