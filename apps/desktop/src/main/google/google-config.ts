// Commander's Google OAuth client, from the private build config (null until the owner adds it), and
// where Google lives (a fake on this machine in tests). Kept free of other imports:
// electron.vite.config.ts loads it (through build-config.ts) under plain Node.

export type GoogleConfig = {
  // The "Desktop app" OAuth client's ID and its secret, which Google says isn't treated as a secret
  // for desktop clients, but which still never goes in the repo.
  clientId: string | null;
  clientSecret: string | null;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  // The Google Calendar API's base, for Google Calendar sync (in the Core).
  calendarUrl: string;
  // The Gmail API's base, for Gmail sync.
  gmailUrl: string;
};

export const GOOGLE_ENDPOINTS = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
  calendarUrl: 'https://www.googleapis.com/calendar/v3',
  gmailUrl: 'https://gmail.googleapis.com',
} as const;
