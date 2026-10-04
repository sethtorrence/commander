import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ghCli } from './gh-cli';

// Reusing gh's sign-in: Commander runs `gh auth token` once, when the User asks, and only when gh is
// installed. A stand-in gh script plays the real one.

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'commander-gh-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fakeGh(script: string) {
  const path = join(dir, 'gh');
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
}

describe.skipIf(process.platform === 'win32')('gh’s sign-in', () => {
  it('is offered only when gh is on the PATH', async () => {
    expect(ghCli({ PATH: dir }).installed).toBe(false);

    await fakeGh('exit 0');

    expect(ghCli({ PATH: `/nonexistent:${dir}` }).installed).toBe(true);
  });

  it('reads the token gh holds for github.com', async () => {
    await fakeGh('[ "$*" = "auth token --hostname github.com" ] && echo gho_from_gh || exit 3');

    expect(await ghCli({ PATH: dir }).token()).toBe('gho_from_gh');
  });

  it('says to sign gh in when it holds no token, without repeating what gh printed', async () => {
    await fakeGh('echo "no oauth token found for github.com" >&2; exit 1');

    await expect(ghCli({ PATH: dir }).token()).rejects.toMatchObject({
      reason: 'invalid-credential',
      message: expect.stringMatching(/gh auth login/),
    });
  });

  it('says gh isn’t installed when it has gone', async () => {
    await expect(ghCli({ PATH: dir }).token()).rejects.toMatchObject({
      reason: 'not-configured',
      message: expect.stringMatching(/isn’t installed/),
    });
  });
});
