import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serveAttachment } from './attachments-protocol';

let root: string;
let dir: string;
const name = `${'a'.repeat(64)}.png`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'commander-protocol-'));
  dir = join(root, 'attachments');
  mkdirSync(dir);
  writeFileSync(join(dir, name), 'png bytes');
  writeFileSync(join(root, 'commander.db'), 'the database');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const get = (url: string, method = 'GET') => serveAttachment({ url, method }, dir);

describe('the attachment protocol', () => {
  it('serves a pasted image from the attachments folder, with its type', async () => {
    const response = await get(`attachment://local/${name}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe('png bytes');
  });

  it.each([
    'attachment://local/commander.db',
    'attachment://local/../commander.db',
    'attachment://local/..%2Fcommander.db',
    `attachment://local/../attachments/${name}`,
    `attachment://local/%2e%2e/attachments/${name}`,
    `attachment://other/${name}`,
    `attachment://local/${name}?v=1`,
    `file:///tmp/attachments/${name}`,
  ])('serves nothing for %s', async (url) => {
    const response = await get(url);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });

  it('serves nothing for an image that is not there', async () => {
    expect((await get(`attachment://local/${'b'.repeat(64)}.png`)).status).toBe(404);
  });

  it('does not follow a link out of the folder', async () => {
    const linked = `${'c'.repeat(64)}.png`;
    symlinkSync(join(root, 'commander.db'), join(dir, linked));
    expect((await get(`attachment://local/${linked}`)).status).toBe(404);
  });

  it('only reads', async () => {
    expect((await get(`attachment://local/${name}`, 'POST')).status).toBe(405);
  });
});
