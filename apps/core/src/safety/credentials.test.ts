import { describe, expect, it } from 'vitest';
import { blankCredentials } from './credentials';

// Credential-like text is replaced with [removed] before material goes to a model. The fake tokens
// are written in two pieces so the source never holds a whole token-shaped string.

const blanked = (text: string) => blankCredentials(text);

describe('blankCredentials', () => {
  it.each([
    ['an Anthropic key', 'key sk' + '-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd', 'key [removed]'],
    ['an OpenAI key', 'use sk' + '-proj-Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56 now', 'use [removed] now'],
    ['a GitHub token', 'GH: gh' + 'p_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8', 'GH: [removed]'],
    [
      'a fine-grained GitHub token',
      'gi' + 'thub_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV',
      '[removed]',
    ],
    ['a Linear API key', 'li' + 'n_api_Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78', '[removed]'],
    ['a Linear OAuth token', 'li' + 'n_oauth_0123456789abcdef0123456789abcdef', '[removed]'],
    ['a Slack token', 'xo' + 'xb-1234567890-0987654321-AbCdEfGhIjKlMnOp', '[removed]'],
    ['an AWS access key', 'AK' + 'IAIOSFODNN7EXAMPLE is the key', '[removed] is the key'],
    ['a Google API key', 'AI' + 'zaSyA-1234567890abcdefghijklmnopqrstu', '[removed]'],
    ['a Google OAuth token', 'ya' + '29.a0AfH6SMBx1234567890abcdefghijk', '[removed]'],
    ['a Stripe key', 'sk' + '_live_51H8xYzAbCdEfGhIjKlMnOpQr', '[removed]'],
    ['a GitLab token', 'gl' + 'pat-AbCdEfGhIjKlMnOpQrSt', '[removed]'],
    ['an npm token', 'np' + 'm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', '[removed]'],
    ['a Z.ai key', 'zai 0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp', 'zai [removed]'],
    [
      'a JWT',
      'ey' + 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      '[removed]',
    ],
  ])('blanks %s', (_name, text, expected) => {
    expect(blanked(text)).toBe(expected);
  });

  it('blanks bearer tokens and Authorization headers, keeping the words around them', () => {
    expect(blanked('curl -H "Authorization: Bearer abc.def-123_456" https://api.test')).toBe(
      'curl -H "Authorization: [removed]" https://api.test',
    );
    expect(blanked('send Bearer 9f8e7d6c5b4a39281706 with it')).toBe('send Bearer [removed] with it');
    expect(blanked('Authorization: Basic dXNlcjpwYXNz')).toBe('Authorization: [removed]');
  });

  it('blanks passwords and secrets written as key: value or key = value', () => {
    expect(blanked('wifi password: hunter2!')).toBe('wifi password: [removed]');
    expect(blanked('PASSWORD=correct-horse-battery')).toBe('PASSWORD=[removed]');
    expect(blanked('"api_key": "abc123def456"')).toBe('"api_key": "[removed]"');
    expect(blanked('client_secret = s3cr3t')).toBe('client_secret = [removed]');
    expect(blanked('the password is Tr0ub4dor&3, ok?')).toBe('the password is [removed], ok?');
    expect(blanked('Cookie: session=abc; theme=dark')).toBe('Cookie: [removed]');
  });

  it('blanks secrets in URLs: OAuth codes, tokens in the query, and passwords in the address', () => {
    expect(blanked('http://localhost:48613/callback?code=4/0AY0e-g7abc&state=xyz')).toBe(
      'http://localhost:48613/callback?code=[removed]&state=xyz',
    );
    expect(blanked('https://api.test/v1?access_token=abc123&page=2')).toBe(
      'https://api.test/v1?access_token=[removed]&page=2',
    );
    expect(blanked('postgres://admin:pa55word@db.internal:5432/app')).toBe(
      'postgres://[removed]@db.internal:5432/app',
    );
  });

  it('blanks a private key block whole', () => {
    const key =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----';
    expect(blanked(`my key:\n${key}\nthanks`)).toBe('my key:\n[removed]\nthanks');
  });

  it('blanks long random-looking strings by their entropy', () => {
    expect(blanked('token Zx8Qp2Lm9Rt4Vb7Nc1Kd6Fg3Hj5Ws0Ya')).toBe('token [removed]');
    expect(blanked('secret 3f9a1c0e7b2d4f6a8c1e3b5d7f9a2c4e6b8d0f1a')).toBe('secret [removed]');
  });

  it('leaves ordinary text alone: words, identifiers, URLs, dates and numbers', () => {
    const ordinary = [
      'Fix the login loop after SSO',
      'See https://linear.app/acme/issue/ENG-418/fix-the-login-loop-after-sso',
      'Ship internationalization-related-improvements by 2026-10-09',
      'Call AbstractSingletonProxyFactoryBean2 from the worker',
      'Q3 numbers: 1,234,567.89 USD',
      'The password reset page is broken',
      'Rotate the signing keys',
      'Tokens are stored only in the keyring',
      // Prose that only looks like key: value.
      'The secret is to start early',
      'the token is expired, so sign in again',
      'Authorization: pending from legal',
      'Cookie: chocolate chip, for the team',
      'Secret: the launch date moves to Friday',
      'the password is changing tomorrow',
    ];
    for (const text of ordinary) expect(blanked(text)).toBe(text);
  });
});
