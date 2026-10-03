// Why connecting a Linear Account failed. The message is shown to the User as it is, so it says
// what happened and what to do; it never contains a token, a key or an authorization code.
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
  | 'keyring-unavailable';

export class SignInError extends Error {
  override name = 'SignInError';
  constructor(
    readonly reason: SignInFailure,
    message: string,
  ) {
    super(message);
  }
}
