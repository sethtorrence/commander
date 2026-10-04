// Commander's Microsoft app, from the private build config (null until the owner adds it), and where
// Microsoft lives (fakes on this machine in tests). Kept free of other imports:
// electron.vite.config.ts loads it (through build-config.ts) under plain Node.

export type MicrosoftConfig = {
  clientId: string | null;
  tenantId: string | null;
  loginUrl: string;
  graphUrl: string;
};

export const MICROSOFT_ENDPOINTS = {
  loginUrl: 'https://login.microsoftonline.com',
  graphUrl: 'https://graph.microsoft.com/v1.0',
} as const;
