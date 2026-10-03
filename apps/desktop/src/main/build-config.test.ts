import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { linearConfig, parseBuildConfig } from './build-config';

const repoRoot = join(import.meta.dirname, '../../../..');

describe('the build config', () => {
  it('commits an example with no client ID, so a fresh checkout offers only API keys', () => {
    const example = parseBuildConfig(JSON.parse(readFileSync(join(repoRoot, 'config/example.json'), 'utf8')));

    expect(example.linear.clientId).toBeNull();
    expect(example.linear.redirectPort).toBeGreaterThan(1024);
  });

  it('reads a client ID and port', () => {
    expect(parseBuildConfig({ linear: { clientId: 'abc123', redirectPort: 48613 } })).toEqual({
      linear: { clientId: 'abc123', redirectPort: 48613 },
    });
  });

  it('treats a blank client ID as none', () => {
    expect(parseBuildConfig({ linear: { clientId: '  ', redirectPort: 48613 } }).linear.clientId).toBeNull();
  });

  it('rejects a malformed config, saying what is wrong', () => {
    expect(() => parseBuildConfig({ linear: { clientId: 'abc', redirectPort: 80 } })).toThrow(/redirectPort/);
    expect(() => parseBuildConfig({})).toThrow(/linear/);
  });
});

describe('the Linear sign-in settings', () => {
  const build = { linear: { clientId: 'abc123', redirectPort: 48613 } };

  it('use Linear’s real endpoints with the build’s client ID and port', () => {
    expect(linearConfig(build, {})).toEqual({
      clientId: 'abc123',
      port: 48613,
      authorizeUrl: 'https://linear.app/oauth/authorize',
      tokenUrl: 'https://api.linear.app/oauth/token',
      apiUrl: 'https://api.linear.app/graphql',
    });
  });

  it('can point at a fake Linear on this machine, for the end-to-end tests', () => {
    const fake = {
      clientId: null,
      port: 50001,
      authorizeUrl: 'http://127.0.0.1:50000/oauth/authorize',
      tokenUrl: 'http://127.0.0.1:50000/oauth/token',
      apiUrl: 'http://localhost:50000/graphql',
    };

    expect(linearConfig(build, { COMMANDER_TEST_LINEAR: JSON.stringify(fake) })).toEqual(fake);
  });

  it('never lets that override send sign-ins anywhere but this machine', () => {
    const elsewhere = {
      clientId: 'x',
      port: 50001,
      authorizeUrl: 'https://evil.example/oauth/authorize',
      tokenUrl: 'http://127.0.0.1:50000/oauth/token',
      apiUrl: 'http://127.0.0.1:50000/graphql',
    };

    expect(() => linearConfig(build, { COMMANDER_TEST_LINEAR: JSON.stringify(elsewhere) })).toThrow(
      /loopback/,
    );
  });
});
