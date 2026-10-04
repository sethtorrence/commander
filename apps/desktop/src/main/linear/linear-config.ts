// Where Linear lives and Commander's Linear app. Kept free of other imports: electron.vite.config.ts
// loads it (through build-config.ts) under plain Node.

export type LinearConfig = {
  // Commander's OAuth app client ID, from the private build config. null: only API keys work.
  clientId: string | null;
  // The fixed loopback port registered with the OAuth app.
  port: number;
  authorizeUrl: string;
  tokenUrl: string;
  apiUrl: string;
};

export const LINEAR_ENDPOINTS = {
  authorizeUrl: 'https://linear.app/oauth/authorize',
  tokenUrl: 'https://api.linear.app/oauth/token',
  apiUrl: 'https://api.linear.app/graphql',
} as const;
