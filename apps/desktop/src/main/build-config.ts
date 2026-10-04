import { z } from 'zod';
import { LINEAR_ENDPOINTS, type LinearConfig } from './linear/linear-config';
import { MICROSOFT_ENDPOINTS, type MicrosoftConfig } from './microsoft/microsoft-config';

// The private build config: app registrations (client IDs, and the Microsoft app's tenant) and
// their fixed loopback ports. The repo is public, so real values live in the git-ignored
// config/local.json; config/example.json is committed with none. electron.vite.config.ts reads
// whichever exists and injects it into the main process at build time. See the README ("Connecting
// Linear", "Connecting Teams").

const port = z.number().int().min(1025).max(65535);

// Blank means none.
const optionalId = z
  .string()
  .nullable()
  .transform((id) => (id?.trim() ? id.trim() : null));

const buildConfig = z.object({
  linear: z.object({
    // Commander's Linear OAuth app. Blank: only personal API keys are offered.
    clientId: optionalId,
    // Registered with the app as http://localhost:<redirectPort>/callback.
    redirectPort: port,
  }),
  // Commander's Entra app (a public client in one tenant). Either blank: Teams can't be connected.
  // Optional, so a config/local.json from before Teams still builds.
  microsoft: z
    .object({ clientId: optionalId, tenantId: optionalId })
    .default({ clientId: null, tenantId: null }),
});

export type BuildConfig = z.infer<typeof buildConfig>;

export function parseBuildConfig(raw: unknown): BuildConfig {
  const parsed = buildConfig.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid build config: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

const loopbackUrl = z
  .string()
  .refine((value) => ['127.0.0.1', 'localhost', '[::1]'].includes(URL.parse(value)?.hostname ?? ''), {
    message: 'must be a loopback URL',
  });

// For the end-to-end tests: an environment variable points a Source at a fake on this machine.
function testOverride<T>(env: NodeJS.ProcessEnv, name: string, schema: z.ZodType<T>): T | null {
  const override = env[name];
  if (!override) return null;
  const parsed = schema.safeParse(JSON.parse(override));
  if (!parsed.success) throw new Error(`Invalid ${name}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

// COMMANDER_TEST_LINEAR points sign-in and sync at a fake Linear.
const linearOverride = z.object({
  clientId: z.string().min(1).nullable(),
  port,
  authorizeUrl: loopbackUrl,
  tokenUrl: loopbackUrl,
  apiUrl: loopbackUrl,
});

export function linearConfig(build: BuildConfig, env: NodeJS.ProcessEnv): LinearConfig {
  return (
    testOverride(env, 'COMMANDER_TEST_LINEAR', linearOverride) ?? {
      clientId: build.linear.clientId,
      port: build.linear.redirectPort,
      ...LINEAR_ENDPOINTS,
    }
  );
}

// COMMANDER_TEST_MICROSOFT points sign-in and Graph at a fake Microsoft (fake-microsoft-server.ts).
const microsoftOverride = z.object({
  clientId: z.string().min(1).nullable(),
  tenantId: z.string().min(1).nullable(),
  loginUrl: loopbackUrl,
  graphUrl: loopbackUrl,
});

export function microsoftConfig(build: BuildConfig, env: NodeJS.ProcessEnv): MicrosoftConfig {
  return (
    testOverride(env, 'COMMANDER_TEST_MICROSOFT', microsoftOverride) ?? {
      ...build.microsoft,
      ...MICROSOFT_ENDPOINTS,
    }
  );
}
