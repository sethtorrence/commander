import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { githubConfig, googleConfig, linearConfig, microsoftConfig, parseBuildConfig } from './build-config';

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

  it('commits no GitHub App either, so a fresh checkout offers only the token fallbacks', () => {
    const example = parseBuildConfig(JSON.parse(readFileSync(join(repoRoot, 'config/example.json'), 'utf8')));

    expect(example.github).toEqual({ clientId: null, appSlug: null });
  });

  it('reads Commander’s GitHub App: its client ID and its slug', () => {
    const build = parseBuildConfig({
      linear: { clientId: null, redirectPort: 48613 },
      github: { clientId: ' Iv23liExample ', appSlug: 'commander-app' },
    });

    expect(build.github).toEqual({ clientId: 'Iv23liExample', appSlug: 'commander-app' });
  });

  it('keeps reading a config from before GitHub, which has no GitHub App', () => {
    expect(parseBuildConfig({ linear: { clientId: 'abc123', redirectPort: 48613 } }).github).toEqual({
      clientId: null,
      appSlug: null,
    });
  });

  it('rejects a GitHub App slug that isn’t one, since it goes into a URL', () => {
    expect(() =>
      parseBuildConfig({
        linear: { clientId: null, redirectPort: 48613 },
        github: { clientId: 'abc', appSlug: '../evil' },
      }),
    ).toThrow(/appSlug/);
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
    github: { clientId: null, appSlug: null },
    google: { clientId: null, clientSecret: null },
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
    github: { clientId: null, appSlug: null },
    google: { clientId: null, clientSecret: null },
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

describe('the GitHub sign-in settings', () => {
  const build = {
    linear: { clientId: null, redirectPort: 48613 },
    microsoft: { clientId: null, tenantId: null },
    github: { clientId: 'Iv23liExample', appSlug: 'commander-app' },
    google: { clientId: null, clientSecret: null },
  };

  it('use GitHub’s real sign-in and API with the build’s app', () => {
    expect(githubConfig(build, {})).toEqual({
      clientId: 'Iv23liExample',
      appSlug: 'commander-app',
      webUrl: 'https://github.com',
      apiUrl: 'https://api.github.com',
    });
  });

  it('can point at a fake GitHub on this machine, for the end-to-end tests', () => {
    const fake = {
      clientId: null,
      appSlug: 'fake-commander',
      webUrl: 'http://127.0.0.1:50000',
      apiUrl: 'http://localhost:50000/api',
    };

    expect(githubConfig(build, { COMMANDER_TEST_GITHUB: JSON.stringify(fake) })).toEqual(fake);
  });

  it('never lets that override send sign-ins or tokens anywhere but this machine', () => {
    for (const elsewhere of [
      { clientId: 'x', appSlug: null, webUrl: 'https://github.com', apiUrl: 'http://127.0.0.1:50000' },
      { clientId: 'x', appSlug: null, webUrl: 'http://127.0.0.1:50000', apiUrl: 'https://evil.example' },
    ]) {
      expect(() => githubConfig(build, { COMMANDER_TEST_GITHUB: JSON.stringify(elsewhere) })).toThrow(
        /loopback/,
      );
    }
  });
});

describe('the Google sign-in settings', () => {
  const example = () =>
    parseBuildConfig(JSON.parse(readFileSync(join(repoRoot, 'config/example.json'), 'utf8')));

  it('commit no Google client, so a fresh checkout can’t connect Google', () => {
    expect(example().google).toEqual({ clientId: null, clientSecret: null });
  });

  it('read the Desktop app client’s ID and secret, and keep reading a config from before Google', () => {
    const build = parseBuildConfig({
      linear: { clientId: null, redirectPort: 48613 },
      google: { clientId: ' 1234-abc.apps.googleusercontent.com ', clientSecret: 'GOCSPX-x' },
    });
    expect(build.google).toEqual({
      clientId: '1234-abc.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-x',
    });
    expect(parseBuildConfig({ linear: { clientId: null, redirectPort: 48613 } }).google).toEqual({
      clientId: null,
      clientSecret: null,
    });
  });

  it('use Google’s real endpoints with the build’s client', () => {
    const build = parseBuildConfig({
      linear: { clientId: null, redirectPort: 48613 },
      google: { clientId: 'id', clientSecret: 'secret' },
    });

    expect(googleConfig(build, {})).toEqual({
      clientId: 'id',
      clientSecret: 'secret',
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    });
  });

  it('can point at a fake Google on this machine, for the end-to-end tests, and nowhere else', () => {
    const fake = {
      clientId: 'fake',
      clientSecret: 'fake-secret',
      authorizeUrl: 'http://127.0.0.1:50000/o/oauth2/v2/auth',
      tokenUrl: 'http://127.0.0.1:50000/token',
      userinfoUrl: 'http://127.0.0.1:50000/v1/userinfo',
    };
    expect(googleConfig(example(), { COMMANDER_TEST_GOOGLE: JSON.stringify(fake) })).toEqual(fake);

    const elsewhere = { ...fake, tokenUrl: 'https://oauth2.googleapis.com/token' };
    expect(() => googleConfig(example(), { COMMANDER_TEST_GOOGLE: JSON.stringify(elsewhere) })).toThrow(
      /loopback/,
    );
  });
});
