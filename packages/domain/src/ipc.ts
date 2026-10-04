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
  // The window draws its own title bar (the header): it reads how the frame behaves here
  // (windowFrame), asks main to minimise, maximise or close (windowControl, with a WindowControl),
  // and main pushes the frame again whenever the window is maximised or restored (windowFrameChanged).
  windowFrame: 'window-frame',
  windowControl: 'window-control',
  windowFrameChanged: 'window-frame-changed',
  // Settings → Notes → Markdown copy folder; see markdown-copy-messages.ts for the validated contract.
  markdownCopy: 'markdown-copy',
  // Ares's Updates; see updates-messages.ts for the validated contract. Main tells the window when
  // the tray's "Ask for an update" was chosen (askForUpdate), and the window runs the Update Skill.
  updates: 'updates',
  askForUpdate: 'ask-for-update',
  // Settings → GitHub: what each GitHub Account watches; see github-watch-messages.ts.
  githubWatch: 'github-watch',
} as const;

// What the header's window controls ask for.
export const WINDOW_CONTROLS = ['minimise', 'toggle-maximise', 'close'] as const;
export type WindowControl = (typeof WINDOW_CONTROLS)[number];

export type WindowFrame = {
  // 'header': Commander draws minimise, maximise and close at the header's right edge.
  // 'native': the platform draws them (macOS traffic lights, inset at the header's left edge).
  controls: 'header' | 'native';
  // What minimise does: minimise to the taskbar, or hide to the tray where the platform has no
  // minimised state (Wayland, Hyprland).
  minimise: 'minimise' | 'hide';
  maximised: boolean;
};

// Whether a model provider's API key is in the keyring. The key itself never reaches the window.
export type ModelKeyStatus = { saved: boolean };
export type SaveModelKeyResult = { ok: true } | { ok: false; error: string };

// Accounts, as the window sees them: never a token or an API key.
// The kinds of Account the User can connect so far (see account-messages.ts). Most are named after
// the one Source they carry; a Google Account carries two (Gmail and Google Calendar), and so does an
// Outlook Account (Outlook mail and Outlook Calendar).
export type AccountSource = 'linear' | 'teams' | 'github' | 'google' | 'outlook';
export type AccountMethod = 'oauth' | 'api-key';
// 'needs-reconnect': its sign-in failed for good (revoked, or a refresh past the replay window).
export type AccountStatus = 'connected' | 'needs-reconnect';
type AccountSummaryBase = {
  id: string;
  // What the User sees: a Linear workspace's name; "Teams · <user principal name>"; a GitHub login.
  name: string;
  method: AccountMethod;
  status: AccountStatus;
  // Who the User is in the Account (their Linear user; their Teams user), for "assigned to me" and
  // "mentions me"; null until known.
  user: { id: string; name: string } | null;
  // Where the Account's syncing stands; null until the Core first reports it.
  sync: AccountSyncStatus | null;
};
export type LinearAccountSummary = AccountSummaryBase & {
  source: 'linear';
  // The workspace's URL key (linear.app/<urlKey>).
  urlKey: string;
};
export type TeamsAccountSummary = AccountSummaryBase & {
  source: 'teams';
  // The work account signed in with (its user principal name, usually its email address).
  userPrincipalName: string;
};
export type GitHubAccountSummary = AccountSummaryBase & {
  source: 'github';
  // The GitHub user's login (github.com/<login>).
  login: string;
  // Commander's GitHub App (device flow), a classic personal access token, or gh's sign-in.
  signedInWith: 'github-app' | 'classic-token' | 'gh';
  // Where Commander's GitHub App is installed (user and organisation logins), as of the last check;
  // null for token Accounts, which don't go through the app.
  installations: string[] | null;
  // The app's "install on another account or org" page; null when this build doesn't know the app.
  installUrl: string | null;
};
// One of the Sources an Account carries, sharing its sign-in. `granted`: the User gave Commander
// every permission it needs (Google lets them untick some; a Microsoft administrator may approve only
// some); `enabled`: the User has it switched on. Only a granted Source can be on. `sync`: where that
// Source's syncing stands, when the Core reported it.
export type CarriedSource = {
  source: AccountSyncStatus['source'];
  granted: boolean;
  enabled: boolean;
  sync?: AccountSyncStatus | null;
};
export type GoogleAccountSummary = AccountSummaryBase & {
  source: 'google';
  // The Google address signed in with.
  email: string;
  // Gmail and Google Calendar.
  sources: CarriedSource[];
};
export type OutlookAccountSummary = AccountSummaryBase & {
  source: 'outlook';
  // The Microsoft account signed in with (its user principal name, usually its email address).
  userPrincipalName: string;
  // Outlook (mail) and Outlook Calendar.
  sources: CarriedSource[];
};
export type AccountSummary =
  | LinearAccountSummary
  | TeamsAccountSummary
  | GitHubAccountSummary
  | GoogleAccountSummary
  | OutlookAccountSummary;
// How this build can connect each Source's Accounts.
export type SourceSignIn = {
  source: AccountSource;
  // Through the browser: this build has the Source's app registration (in config/local.json).
  oauth: boolean;
  // With a personal API key or token instead (Linear, GitHub).
  apiKey: boolean;
  // By reusing a command-line tool's sign-in on this machine (GitHub: gh), when it is installed.
  cli?: boolean;
};
// A device sign-in waiting for the User to enter its code at the Source (GitHub): the short code
// to type, and where. Never the device code Commander polls with.
export type DeviceCodePrompt = { userCode: string; verificationUri: string; expiresAt: number };
// The Source's organisation needs an administrator to approve Commander before the User can sign
// in: which permissions to approve, and the organisation's admin consent page for Commander's app.
export type AdminConsentNeeded = { permissions: string[]; url: string };
// An Account's sync, as the Core reports it (validated in sync-messages.ts).
export type AccountSyncStatus = {
  account: string;
  source: 'gmail' | 'outlook' | 'google-calendar' | 'outlook-calendar' | 'teams' | 'linear' | 'github';
  activity: 'idle' | 'syncing' | 'backing-off' | 'offline' | 'asleep' | 'needs-reconnect';
  cadenceMinutes: number;
  cadenceChoices: number[];
  lastSyncedAt: number | null;
  nextSyncAt: number | null;
  itemCount: number;
  problem: { kind: 'rate-limited' | 'refused' | 'failed'; message: string } | null;
  // Changes made in Commander still on their way to the Source, and those that couldn't sync.
  outgoing: { pending: number; failed: number };
  // Sources with a light sync only (Teams): whether it also checks whenever another Source syncs.
  alsoAfterOtherSources?: boolean;
};
export type AccountsState = {
  accounts: AccountSummary[];
  // Each Source's ways of connecting in this build, in the order Settings → Accounts shows them.
  sources: SourceSignIn[];
  // The device sign-in waiting for its code to be entered, if any.
  deviceCode?: (DeviceCodePrompt & { source: AccountSource }) | null;
};
export type AccountsRequest =
  | { op: 'list' }
  // `reconnect` names the Account being reconnected: the sign-in must be for the same identity
  // (Linear: its workspace; Teams and GitHub: its user).
  | { op: 'connect'; source: AccountSource; method: 'oauth'; reconnect?: string }
  | { op: 'connect'; source: 'linear' | 'github'; method: 'api-key'; apiKey: string; reconnect?: string }
  // Reuses gh's sign-in on this machine (`gh auth token`).
  | { op: 'connect'; source: 'github'; method: 'cli'; reconnect?: string }
  // Asks the Source again about the Account (GitHub: where Commander's app is installed).
  | { op: 'refresh-details'; accountId: string }
  | { op: 'cancel-sign-in' }
  | { op: 'remove'; accountId: string }
  // Switches one of the Sources an Account carries on or off (only a granted one can be on).
  | { op: 'set-source-enabled'; accountId: string; source: CarriedSource['source']; enabled: boolean }
  // Syncs the Account at once (Sync now; Sections call it when they open), or just one of the
  // Sources it carries (the Calendar Section refreshes only Google Calendar).
  | { op: 'sync-now'; accountId: string; source?: AccountSyncStatus['source'] }
  // Minutes between the Account's syncs, from its Source's choices.
  | { op: 'set-sync-cadence'; accountId: string; minutes: number }
  // Teams: whether to also check whenever another Source syncs.
  | { op: 'set-sync-also-after-other-sources'; accountId: string; enabled: boolean };
export type AccountsResponse =
  | { ok: true; state: AccountsState }
  // `source`: the Source the failure is about, when it is about one. `adminConsent`: the sign-in
  // needs an administrator's approval first.
  | {
      ok: false;
      error: string;
      source?: AccountSource;
      adminConsent?: AdminConsentNeeded;
      state: AccountsState;
    };

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
