import { createHash, randomBytes } from 'node:crypto';

// Proof Key for Code Exchange (RFC 7636), S256 only. The verifier stays in the main process; only
// its challenge goes to the browser, and the verifier goes straight to the token endpoint.
export type Pkce = { verifier: string; challenge: string; method: 'S256' };

export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function createPkce(): Pkce {
  // 32 random bytes give a 43-character base64url verifier: the shortest the RFC allows, 256 bits.
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: challengeFor(verifier), method: 'S256' };
}
