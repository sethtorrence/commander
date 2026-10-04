import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { linearConfig, microsoftConfig, parseBuildConfig } from './build-config';

const repoRoot = join(import.meta.dirname, '../../../..');

describe('the build config', () => {
  it('commits an example with no client ID, so a fresh checkout offers only API keys', () => {
    const example = parseBuildConfig(JSON.parse(readFileSync(join(repoRoot, 'config/example.json'), 'utf8')));

    expect(example.linear.clientId).toBeNull();
    expect(example.linear.redirectPort).toBeGreaterThan(1024);
  });

  it('reads a client ID and port', () => {
    expect(parseBuildConfig({ linear: { clientId: 'abc123', redirectPort: 48613 } }).linear).toEqual({
      clientId: 'abc123',
      redirectPort: 48613,
    });
  });

  it('commits no Microsoft app either, so a fresh checkout can’t connect Teams', () => {
    const example = parseBuildConfig(JSON.parse(readFileSync(join(repoRoot, 'config/example.json'), 'utf8')));

    expect(example.microsoft).toEqual({ clientId: null, tenantId: null });
  });

  it('reads Commander’s Microsoft app: its client ID and its tenant', () => {
    const build = parseBuildConfig({
      linear: { clientId: null, redirectPort: 48613 },
      microsoft: { clientId: ' app-id ', tenantId: 'tenant-id' },
    });

    expect(build.microsoft).toEqual({ clientId: 'app-id', tenantId: 'tenant-id' });
  });

  it('keeps reading a config from before Teams, which has no Microsoft app', () => {
    expect(parseBuildConfig({ linear: { clientId: 'abc123', redirectPort: 48613 } }).microsoft).toEqual({
      clientId: null,
      tenantId: null,
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
  const build = {
    linear: { clientId: 'abc123', redirectPort: 48613 },
    microsoft: { clientId: null, tenantId: null },
  };

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

describe('the Microsoft sign-in settings', () => {
  const build = {
    linear: { clientId: null, redirectPort: 48613 },
    microsoft: { clientId: 'app-id', tenantId: 'tenant-id' },
  };

  it('use Microsoft’s real identity platform and Graph with the build’s app', () => {
    expect(microsoftConfig(build, {})).toEqual({
      clientId: 'app-id',
      tenantId: 'tenant-id',
      loginUrl: 'https://login.microsoftonline.com',
      graphUrl: 'https://graph.microsoft.com/v1.0',
    });
  });

  it('can point at a fake Microsoft on this machine, for the end-to-end tests', () => {
    const fake = {
      clientId: 'fake-app',
      tenantId: 'fake-tenant',
      loginUrl: 'http://127.0.0.1:50000',
      graphUrl: 'http://[::1]:50000/v1.0',
    };

    expect(microsoftConfig(build, { COMMANDER_TEST_MICROSOFT: JSON.stringify(fake) })).toEqual(fake);
  });

  it('never lets that override send sign-ins anywhere but this machine', () => {
    const elsewhere = {
      clientId: 'x',
      tenantId: 'y',
      loginUrl: 'https://login.microsoftonline.com',
      graphUrl: 'http://127.0.0.1:50000/v1.0',
    };

    expect(() => microsoftConfig(build, { COMMANDER_TEST_MICROSOFT: JSON.stringify(elsewhere) })).toThrow(
      /loopback/,
    );
  });
});
