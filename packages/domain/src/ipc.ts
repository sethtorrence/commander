// The contract between the main process and the window, carried over the preload bridge.
export const ipc = {
  coreMessage: 'core-message',
  diagnostics: 'diagnostics',
  secretStorageStatus: 'secret-storage-status',
  // Item store requests from the window; see item-store-messages.ts for the validated contract.
  itemStore: 'item-store',
  // Autonomy settings and Ares's activity; see autonomy-messages.ts for the validated contract.
  autonomy: 'autonomy',
  startAtLogin: 'start-at-login',
  setStartAtLogin: 'set-start-at-login',
  // The window has painted its first frame, in the User's theme, so it can be shown.
  framePainted: 'frame-painted',
  // Settings → Accounts; see account-messages.ts for the validated contract.
  accounts: 'accounts',
  accountsChanged: 'accounts-changed',
  // Settings → Ares: requests relayed to the Core (model-messages.ts), and the model API key, which
  // goes to the main process only and is never read back.
  models: 'models',
  modelKeyStatus: 'model-key-status',
  saveModelKey: 'save-model-key',
  clearModelKey: 'clear-model-key',
  // Commander is quitting: main asks the window to save the edits it holds (with a request id), and
  // the window answers on savedBeforeQuit with that id once they are saved.
  saveBeforeQuit: 'save-before-quit',
  savedBeforeQuit: 'saved-before-quit',
} as const;

// Whether a model provider's API key is in the keyring. The key itself never reaches the window.
export type ModelKeyStatus = { saved: boolean };
export type SaveModelKeyResult = { ok: true } | { ok: false; error: string };

// Accounts, as the window sees them: never a token or an API key.
export type AccountMethod = 'oauth' | 'api-key';
// 'needs-reconnect': its sign-in failed for good (revoked, or a refresh past the replay window).
export type AccountStatus = 'connected' | 'needs-reconnect';
export type AccountSummary = {
  id: string;
  source: 'linear';
  name: string;
  urlKey: string;
  method: AccountMethod;
  status: AccountStatus;
  // Who the User is in the Account (their Linear user), for "assigned to me"; null until known.
  user: { id: string; name: string } | null;
  // Where the Account's syncing stands; null until the Core first reports it.
  sync: AccountSyncStatus | null;
};
// An Account's sync, as the Core reports it (validated in sync-messages.ts).
export type AccountSyncStatus = {
  account: string;
  source: 'gmail' | 'outlook' | 'google-calendar' | 'teams' | 'linear' | 'github';
  activity: 'idle' | 'syncing' | 'backing-off' | 'offline' | 'asleep' | 'needs-reconnect';
  cadenceMinutes: number;
  cadenceChoices: number[];
  lastSyncedAt: number | null;
  nextSyncAt: number | null;
  itemCount: number;
  problem: { kind: 'rate-limited' | 'refused' | 'failed'; message: string } | null;
};
export type AccountsState = {
  accounts: AccountSummary[];
  // Whether this build has a Linear OAuth app configured; without one only API keys are offered.
  linearOAuth: boolean;
};
export type AccountsRequest =
  | { op: 'list' }
  // `reconnect` names the Account being reconnected: the sign-in must be for its workspace.
  | { op: 'connect-linear'; method: 'oauth'; reconnect?: string }
  | { op: 'connect-linear'; method: 'api-key'; apiKey: string; reconnect?: string }
  | { op: 'cancel-sign-in' }
  | { op: 'remove'; accountId: string }
  // Syncs the Account at once (Sync now; Sections call it when they open).
  | { op: 'sync-now'; accountId: string }
  // Minutes between the Account's syncs, from its Source's choices.
  | { op: 'set-sync-cadence'; accountId: string; minutes: number };
export type AccountsResponse =
  | { ok: true; state: AccountsState }
  | { ok: false; error: string; state: AccountsState };

// How the window reaches the screen. 'xwayland' means a Wayland session fell back to X11.
export type DisplayServer = 'wayland' | 'xwayland' | 'x11' | 'other';

export type Diagnostics = {
  displayServer: DisplayServer;
  // 'compositor' when the compositor confirmed it, 'inferred' when guessed from launch switches.
  displaySource: 'compositor' | 'inferred';
  passwordStore: string;
  electron: string;
};

// Where Account tokens and API keys are kept. The window only ever learns this status, never a secret.
export type SecretStorageStatus = {
  // safeStorage's backend on Linux (e.g. 'gnome_libsecret', 'basic_text'); 'keychain' or 'dpapi' elsewhere.
  backend: string;
  // True only when secrets are encrypted by a real OS keyring.
  protected: boolean;
  // A User-facing explanation of what's wrong and how to fix it, when not protected.
  problem: string | null;
};
