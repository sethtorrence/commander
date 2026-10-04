import { z } from 'zod';
import type { SourceCredential } from '../accounts/source-accounts';
import { SignInError } from '../oauth/sign-in-error';

// Who a Microsoft sign-in is for, from Graph's `GET /me`: the user's id (which keys their Accounts,
// with the tenant), name and user principal name (which names them). Shared by every Microsoft
// Source's Accounts (Teams, Outlook).

export type MicrosoftUser = { id: string; displayName: string | null; userPrincipalName: string };

const me = z.object({
  id: z.string().min(1),
  displayName: z.string().nullable(),
  userPrincipalName: z.string().min(1),
});

// `label`: the Source being connected ("Teams"), for the message when the credential isn't a sign-in.
export async function readMicrosoftUser(
  graphUrl: string,
  credential: SourceCredential,
  label: string,
): Promise<MicrosoftUser> {
  if (credential.kind !== 'oauth')
    throw new SignInError('invalid-credential', `${label} needs a Microsoft sign-in.`);
  let response: Response;
  try {
    response = await fetch(`${graphUrl}/me?$select=id,displayName,userPrincipalName`, {
      headers: { authorization: `Bearer ${credential.accessToken}`, accept: 'application/json' },
    });
  } catch {
    throw new SignInError(
      'unreachable',
      'Commander couldn’t reach Microsoft. Check your connection and try again.',
    );
  }
  const parsed = me.safeParse(await response.json().catch(() => null));
  if (response.ok && parsed.success) return parsed.data;
  if (response.status === 401 || response.status === 403) {
    throw new SignInError('invalid-credential', 'Microsoft didn’t accept the sign-in. Try connecting again.');
  }
  throw new SignInError(
    'unreachable',
    `Microsoft couldn’t answer just now (HTTP ${response.status}). Try again.`,
  );
}
