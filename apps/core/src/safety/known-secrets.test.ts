import { describe, expect, it } from 'vitest';
import { createKnownSecrets } from './known-secrets';

// The tokens and keys the Core borrows from the secrets module are remembered by fingerprint, so a
// prompt holding one can be refused.

describe('known secrets', () => {
  it('finds a remembered token anywhere in a text, however it is surrounded', () => {
    const secrets = createKnownSecrets();
    secrets.remember('lin_oauth_0123456789abcdef0123456789abcdef');
    secrets.remember('0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp');

    expect(secrets.foundIn('nothing here')).toBe(false);
    expect(secrets.foundIn('token=lin_oauth_0123456789abcdef0123456789abcdef;')).toBe(true);
    expect(secrets.foundIn('(key: 0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp)')).toBe(true);
    expect(secrets.foundIn('xlin_oauth_0123456789abcdef0123456789abcdefx')).toBe(true);
    // Most of a token isn't the token.
    expect(secrets.foundIn('lin_oauth_0123456789abcdef0123456789abcde')).toBe(false);
  });

  it('keeps only fingerprints, never the values', () => {
    const secrets = createKnownSecrets();
    const token = 'lin_api_Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78';
    secrets.remember(token);
    expect(JSON.stringify(secrets)).not.toContain(token);
    expect(JSON.stringify(secrets.fingerprints())).not.toContain('Ab12Cd34');
  });

  it('ignores values too short to be a secret', () => {
    const secrets = createKnownSecrets();
    secrets.remember('abc');
    secrets.remember('');
    expect(secrets.foundIn('abc abc')).toBe(false);
  });

  it('finds a secret with characters outside the usual token alphabet', () => {
    const secrets = createKnownSecrets();
    secrets.remember('p@ss w0rd!#2026');
    expect(secrets.foundIn('my p@ss w0rd!#2026 here')).toBe(true);
  });
});
