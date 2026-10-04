// Commander's GitHub App, from the private build config (null until the owner registers it), and
// where GitHub lives (a fake on this machine in tests). Kept free of other imports:
// electron.vite.config.ts loads it (through build-config.ts) under plain Node.

export type GitHubConfig = {
  // The GitHub App's client ID. null: only the token fallbacks are offered.
  clientId: string | null;
  // The app's slug, from its public page (github.com/apps/<slug>), for "Install on another org…".
  appSlug: string | null;
  // Where the device flow and the app's pages live: https://github.com.
  webUrl: string;
  // The REST API's base (GraphQL is <apiUrl>/graphql): https://api.github.com.
  apiUrl: string;
};

export const GITHUB_ENDPOINTS = {
  webUrl: 'https://github.com',
  apiUrl: 'https://api.github.com',
} as const;
