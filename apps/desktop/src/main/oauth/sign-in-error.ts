// Why connecting an Account failed. The message is shown to the User as it is, so it says what
// happened and what to do; it never contains a token, a key or an authorization code.
export type SignInFailure =
  | 'not-configured'
  | 'port-in-use'
  | 'state-mismatch'
  | 'declined'
  | 'timed-out'
  | 'cancelled'
  | 'exchange-failed'
  | 'invalid-credential'
  | 'unreachable'
  | 'wrong-workspace'
  | 'wrong-account'
  | 'admin-consent'
  // A Google Workspace admin hasn't allowed Commander (admin_policy_enforced, org_internal).
  | 'admin-blocked'
  | 'keyring-unavailable';

// What the Source itself said when it refused (OAuth's `error` and `error_description`), so a
// Source can tell its own cases apart (Microsoft's AADSTS codes, say).
export type SourceError = { code: string; description: string };

// The Source's tenant needs an administrator to approve Commander before the User can sign in.
export type AdminConsentNeeded = { permissions: string[]; url: string };

export class SignInError extends Error {
  override name = 'SignInError';
  constructor(
    readonly reason: SignInFailure,
    message: string,
    readonly details: { sourceError?: SourceError; adminConsent?: AdminConsentNeeded } = {},
  ) {
    super(message);
  }

  get sourceError(): SourceError | undefined {
    return this.details.sourceError;
  }

  get adminConsent(): AdminConsentNeeded | undefined {
    return this.details.adminConsent;
  }
}
