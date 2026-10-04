import { describe, expect, it } from 'vitest';
import { markFromInternet } from './internet-mark';

describe('marking an attachment as from the internet', () => {
  it('writes the Mark of the Web on Windows', async () => {
    const written: [string, string][] = [];
    await markFromInternet('C:\\Users\\me\\Downloads\\a.pdf', {
      platform: 'win32',
      write: async (path, data) => {
        written.push([path, data]);
      },
    });
    expect(written).toEqual([
      ['C:\\Users\\me\\Downloads\\a.pdf:Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n'],
    ]);
  });

  it('sets the quarantine attribute on macOS', async () => {
    const ran: string[][] = [];
    await markFromInternet('/Users/me/a.docx', {
      platform: 'darwin',
      now: () => 0x65000000 * 1000,
      run: async (command, args) => ran.push([command, ...args]),
    });
    expect(ran).toEqual([
      ['xattr', '-w', 'com.apple.quarantine', '0081;65000000;Commander;', '/Users/me/a.docx'],
    ]);
  });

  it('does nothing on Linux, which has no such mark', async () => {
    const calls: unknown[] = [];
    await markFromInternet('/home/me/a.pdf', {
      platform: 'linux',
      run: async (...args) => calls.push(args),
      write: async (...args) => {
        calls.push(args);
      },
    });
    expect(calls).toEqual([]);
  });

  it('fails when the mark can’t be written', async () => {
    await expect(
      markFromInternet('/x', {
        platform: 'darwin',
        run: async () => {
          throw new Error('no xattr');
        },
      }),
    ).rejects.toThrow('no xattr');
  });
});
