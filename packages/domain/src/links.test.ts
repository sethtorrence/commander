import { describe, expect, it } from 'vitest';
import { isOpenableLink } from './links';

describe('links that open in the system browser', () => {
  it.each([
    'https://example.com',
    'http://example.com/a?b=c#d',
    'HTTPS://EXAMPLE.COM/',
    'mailto:someone@example.com',
    'mailto:someone@example.com?subject=Hi',
  ])('open %j', (url) => {
    expect(isOpenableLink(url)).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox',
    'attachment://local/x.png',
    'ftp://example.com',
    'smb://server/share',
    'ssh://host',
    'chrome://settings',
    'https://',
    'http:///path',
    'example.com',
    '//example.com',
    '',
    `https://example.com/${'a'.repeat(5000)}`,
  ])('refuse %j', (url) => {
    expect(isOpenableLink(url)).toBe(false);
  });

  it('refuses what is not a string', () => {
    expect(isOpenableLink(undefined)).toBe(false);
    expect(isOpenableLink({ toString: () => 'https://example.com' })).toBe(false);
  });
});
