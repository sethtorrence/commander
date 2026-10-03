import { z } from 'zod';
import { LINEAR_ENDPOINTS, type LinearConfig } from './linear/linear-accounts';

// The private build config: app registrations (client IDs) and their fixed loopback ports. The
// repo is public, so real values live in the git-ignored config/local.json; config/example.json
// is committed with none. electron.vite.config.ts reads whichever exists and injects it into the
// main process at build time. See the README ("Connecting Linear").

const port = z.number().int().min(1025).max(65535);

const buildConfig = z.object({
  linear: z.object({
    // Commander's Linear OAuth app. Blank: only personal API keys are offered.
    clientId: z
      .string()
      .nullable()
      .transform((id) => (id?.trim() ? id.trim() : null)),
    // Registered with the app as http://localhost:<redirectPort>/callback.
    redirectPort: port,
  }),
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

// For the end-to-end tests: COMMANDER_TEST_LINEAR points sign-in at a fake Linear on this machine.
const testOverride = z.object({
  clientId: z.string().min(1).nullable(),
  port,
  authorizeUrl: loopbackUrl,
  tokenUrl: loopbackUrl,
  apiUrl: loopbackUrl,
});

export function linearConfig(build: BuildConfig, env: NodeJS.ProcessEnv): LinearConfig {
  const override = env.COMMANDER_TEST_LINEAR;
  if (override) {
    const parsed = testOverride.safeParse(JSON.parse(override));
    if (!parsed.success) throw new Error(`Invalid COMMANDER_TEST_LINEAR: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
  }
  return { clientId: build.linear.clientId, port: build.linear.redirectPort, ...LINEAR_ENDPOINTS };
}
