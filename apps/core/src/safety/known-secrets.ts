// The tokens and keys the Core borrows from the secrets module (Account tokens, model API keys,
// through access-tokens.ts) are remembered here so the prompt builder can refuse any material that
// holds one (#69). Only SHA-256 fingerprints and lengths are kept, never the values: checking a text
// hashes each stretch of it that could be a remembered secret.
import { createHash } from 'node:crypto';

export type KnownSecrets = {
  // A token or key the Core was handed.
  remember(value: string): void;
  // Whether any remembered token or key appears in the text.
  foundIn(text: string): boolean;
  // The fingerprints kept (for tests: proof the values aren't).
  fingerprints(): string[];
};

// Shorter than this, a value is no secret worth matching (and would match by chance).
const MIN_LENGTH = 8;
// The characters tokens and keys are made of: a secret made only of these is looked for inside
// runs of them, which keeps the check fast; any other is looked for everywhere.
const TOKEN_CHARS = /^[A-Za-z0-9_\-.~+/]+$/;
const TOKEN_RUN = /[A-Za-z0-9_\-.~+/]+/g;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export function createKnownSecrets(): KnownSecrets {
  // By length: the fingerprints of the secrets of that length, and whether any of them has
  // characters outside a token's.
  const byLength = new Map<number, { hashes: Set<string>; anywhere: boolean }>();

  function windowsMatch(text: string, length: number, hashes: Set<string>): boolean {
    for (let at = 0; at + length <= text.length; at++) {
      if (hashes.has(sha256(text.slice(at, at + length)))) return true;
    }
    return false;
  }

  return {
    remember(value) {
      if (value.length < MIN_LENGTH) return;
      const entry = byLength.get(value.length) ?? { hashes: new Set<string>(), anywhere: false };
      entry.hashes.add(sha256(value));
      if (!TOKEN_CHARS.test(value)) entry.anywhere = true;
      byLength.set(value.length, entry);
    },

    foundIn(text) {
      if (!byLength.size) return false;
      const runs = text.match(TOKEN_RUN) ?? [];
      for (const [length, { hashes, anywhere }] of byLength) {
        if (anywhere && windowsMatch(text, length, hashes)) return true;
        for (const run of runs) if (run.length >= length && windowsMatch(run, length, hashes)) return true;
      }
      return false;
    },

    fingerprints: () => [...byLength.values()].flatMap(({ hashes }) => [...hashes]),
  };
}
