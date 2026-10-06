import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { load as loadSqliteVec } from 'sqlite-vec';

/*
  Vectors in SQLite, shared by search's and Memory's meaning indexes (#73). Embeddings are stored as
  float32 BLOBs in ordinary tables and compared with sqlite-vec's `vec_distance_cosine` (a pinned
  0.1.9, MIT OR Apache-2.0), as an exact scan joined with the tables filters live in: at Commander's
  scale (tens of thousands of Items) that answers in tens of milliseconds, with every filter applied
  in the same query. sqlite-vec is a loadable extension, not a Node addon, so it loads the same in
  Node (Vitest) and in Electron's utilityProcess. Where it can't load (a platform it has no build
  for), the same function is registered in JavaScript instead, slower but the same answers.
*/

export type VectorEngine = 'sqlite-vec' | 'javascript';

const engines = new WeakMap<Database.Database, VectorEngine>();

function cosineDistance(a: Buffer, b: Buffer): number | null {
  if (a.byteLength !== b.byteLength || a.byteLength % 4) return null;
  const x = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
  const y = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  let dot = 0;
  let xx = 0;
  let yy = 0;
  for (let i = 0; i < x.length; i++) {
    const p = x[i] as number;
    const q = y[i] as number;
    dot += p * q;
    xx += p * p;
    yy += q * q;
  }
  return xx && yy ? 1 - dot / Math.sqrt(xx * yy) : 1;
}

/** Makes `vec_distance_cosine` available on this connection, once. */
export function vectorFunctions(sqlite: Database.Database): VectorEngine {
  const known = engines.get(sqlite);
  if (known) return known;
  let engine: VectorEngine = 'sqlite-vec';
  try {
    loadSqliteVec(sqlite);
  } catch (error) {
    engine = 'javascript';
    console.warn(
      `sqlite-vec couldn’t load (${error instanceof Error ? error.message : error}); search by meaning compares vectors in JavaScript instead.`,
    );
    sqlite.function('vec_distance_cosine', { deterministic: true }, (a, b) =>
      Buffer.isBuffer(a) && Buffer.isBuffer(b) ? cosineDistance(a, b) : null,
    );
  }
  engines.set(sqlite, engine);
  return engine;
}

/** A vector as SQLite stores it: its float32s, little-endian, in a BLOB. */
export const blobOf = (vector: Float32Array): Buffer =>
  Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

/** A short fingerprint of the text an embedding was made from, to tell when it no longer fits. */
export const textHash = (text: string): string => createHash('sha1').update(text).digest('base64url');

// The most Items (or memories) one query finds by meaning: the rest of the nearest are noise.
export const MEANING_HITS = 10;

/**
 * Of rows ordered nearest first, those near enough to what was typed: within the model's similarity
 * floor and, with a margin, nearly as near as the nearest (an embedding model's similarities crowd
 * together, so the nearest says what "near" means for this query), at most MEANING_HITS.
 */
export function nearEnough<Row extends { distance: number | null }>(
  rows: readonly Row[],
  meaning: { minSimilarity: number; margin?: number },
): Row[] {
  const best = rows[0]?.distance;
  if (best === null || best === undefined) return [];
  const floor = Math.max(
    meaning.minSimilarity,
    meaning.margin === undefined ? -1 : 1 - best - meaning.margin,
  );
  return rows.filter((row) => row.distance !== null && 1 - row.distance >= floor).slice(0, MEANING_HITS);
}
