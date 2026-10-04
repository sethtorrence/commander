import {
  RefreshError,
  refreshTokens as refreshWith,
  signInWithBrowser as signInWith,
  type TokenSet,
} from '../oauth/authorization-code';

// Linear's OAuth 2.0 for a public desktop client: authorization code with PKCE (S256) and no
// client secret, the browser coming back to a fixed, registered loopback port, 24-hour access
// tokens, and refresh tokens that rotate on every refresh. The flow itself is shared by every Source
// (oauth/authorization-code.ts).

export { RefreshError, type TokenSet };

// What Commander needs to sign in with its own registered OAuth app.
export type OAuthClient = {
  clientId: string;
  // The fixed loopback port registered with the app (http://localhost:<port>/callback).
  port: number;
  authorizeUrl: string;
  tokenUrl: string;
};

// "read,write": issue edits, comments and new issues. Linear separates scopes with commas.
const SCOPES = 'read,write';

const linearClient = (client: OAuthClient) => ({
  ...client,
  sourceName: 'Linear',
  callbackPath: '/callback',
  scope: SCOPES,
});

// Opens the system browser on Linear's consent page and waits for its redirect to the loopback
// listener, then exchanges the code. The listener is closed when this settles, however it ends.
export async function signInWithBrowser({
  client,
  ...options
}: {
  client: OAuthClient;
  openBrowser: (url: string) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
}): Promise<TokenSet> {
  const { idToken: _idToken, ...tokens } = await signInWith({ client: linearClient(client), ...options });
  return tokens;
}

export function refreshTokens({
  client,
  ...options
}: {
  client: Pick<OAuthClient, 'clientId' | 'tokenUrl'>;
  refreshToken: string;
  now?: () => number;
}): Promise<TokenSet> {
  return refreshWith({ client: { ...client, sourceName: 'Linear' }, ...options });
}
