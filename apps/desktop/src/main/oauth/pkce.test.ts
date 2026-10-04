import { describe, expect, it } from 'vitest';
import { challengeFor, createPkce } from './pkce';

describe('PKCE (S256)', () => {
  it('derives the challenge from the verifier as RFC 7636 specifies', () => {
    // The worked example in RFC 7636, Appendix B.
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('makes a fresh, high-entropy verifier every time, with its matching challenge', () => {
    const first = createPkce();
    const second = createPkce();

    expect(first.verifier).not.toBe(second.verifier);
    expect(first.verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(first.challenge).toBe(challengeFor(first.verifier));
    expect(first.method).toBe('S256');
  });
});
