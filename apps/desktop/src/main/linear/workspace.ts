import { z } from 'zod';
import { SignInError } from './sign-in-error';

// Every Linear credential covers one workspace. After signing in (or when an API key is pasted),
// Commander asks Linear whose it is: that names the Account and keys it by workspace.

export type Workspace = { id: string; name: string; urlKey: string };

export type LinearCredential = { kind: 'oauth'; accessToken: string } | { kind: 'api-key'; apiKey: string };

// OAuth access tokens go as "Bearer <token>"; personal API keys go bare.
export function authorizationFor(credential: LinearCredential): string {
  return credential.kind === 'oauth' ? `Bearer ${credential.accessToken}` : credential.apiKey;
}

const VIEWER_QUERY = 'query CommanderWorkspace { viewer { organization { id name urlKey } } }';

const viewerResponse = z.object({
  data: z.object({
    viewer: z.object({
      organization: z.object({ id: z.string().min(1), name: z.string(), urlKey: z.string() }),
    }),
  }),
});

export async function readWorkspace({
  apiUrl,
  credential,
}: {
  apiUrl: string;
  credential: LinearCredential;
}): Promise<Workspace> {
  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: authorizationFor(credential) },
      body: JSON.stringify({ query: VIEWER_QUERY }),
    });
  } catch {
    throw new SignInError(
      'unreachable',
      'Commander couldn’t reach Linear. Check your connection and try again.',
    );
  }
  const parsed = viewerResponse.safeParse(await response.json().catch(() => null));
  if (parsed.success) return parsed.data.data.viewer.organization;
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new SignInError(
      'invalid-credential',
      credential.kind === 'api-key'
        ? 'Linear didn’t accept that API key. Check it was copied whole, and that it hasn’t been revoked.'
        : 'Linear didn’t accept the sign-in. Try connecting again.',
    );
  }
  throw new SignInError(
    'unreachable',
    `Linear couldn’t answer just now (HTTP ${response.status}). Try again.`,
  );
}
