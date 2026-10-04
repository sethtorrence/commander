import { z } from 'zod';

// Models: what Ares runs on. Two tiers (Quick and Deep), each set to a provider and model with a
// thinking level, plus per-job overrides, an optional monthly cap and the usage ledger's rows.
// The model interface itself lives in packages/models; these are the shapes that cross processes.

export const modelTiers = ['quick', 'deep'] as const;
export const modelTier = z.enum(modelTiers);
export type ModelTier = z.infer<typeof modelTier>;

// Only Z.ai in M3. Anthropic, OpenAI and a local model join this list later.
export const modelProviders = ['zai'] as const;
export const modelProvider = z.enum(modelProviders);
export type ModelProvider = z.infer<typeof modelProvider>;

// How hard the model thinks. GLM-5.3-Flash always thinks; these are the levels it accepts.
export const reasoningEfforts = ['low', 'high', 'max'] as const;
export const reasoningEffort = z.enum(reasoningEfforts);
export type ReasoningEffort = z.infer<typeof reasoningEffort>;

export const ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4';
export const ZAI_MODEL = 'glm-5.3-flash';

// The Core borrows a model provider's API key from the main process with the same access token
// request Accounts use (account-messages.ts), naming this reserved id instead of an Account.
export const modelKeyAccount = (provider: ModelProvider) => `model-key:${provider}`;
export const modelKeyProvider = (account: string): ModelProvider | null => {
  const provider = modelProvider.safeParse(account.startsWith('model-key:') ? account.slice(10) : null);
  return provider.success ? provider.data : null;
};

// One tier's model. The base URL is a setting, so any OpenAI-compatible server can stand in.
export const tierSetting = z.object({
  provider: modelProvider,
  model: z.string().trim().min(1).max(200),
  baseUrl: z.url({ protocol: /^https?$/ }).max(500),
  reasoningEffort,
});
export type TierSetting = z.infer<typeof tierSetting>;

// A job's own thinking level, overriding its tier's.
export const jobOverride = z.object({ reasoningEffort });
export type JobOverride = z.infer<typeof jobOverride>;

export const jobName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Job names are lower-case words joined by hyphens');

export const modelSettings = z.object({
  tiers: z.object({ quick: tierSetting, deep: tierSetting }),
  jobOverrides: z.record(jobName, jobOverride),
  // In US dollars per calendar month; null means no cap.
  monthlyCapUsd: z.number().positive().max(100_000).nullable(),
  // Where Deep-tier calls go once the month's spend reaches the cap; null means they stop instead.
  deepFallback: tierSetting.nullable(),
  // How many messages from others since the last Update make a Chat busy enough for Ares to
  // summarise it in the Update (#109); 20 when not set (teams-ares.ts).
  busyChatMessages: z.number().int().min(2).max(1000).optional(),
});
export type ModelSettings = z.infer<typeof modelSettings>;

export const defaultModelSettings: ModelSettings = {
  tiers: {
    quick: { provider: 'zai', model: ZAI_MODEL, baseUrl: ZAI_BASE_URL, reasoningEffort: 'low' },
    deep: { provider: 'zai', model: ZAI_MODEL, baseUrl: ZAI_BASE_URL, reasoningEffort: 'high' },
  },
  jobOverrides: {},
  monthlyCapUsd: null,
  deepFallback: null,
};

// Why a model call failed, in provider-neutral terms. The job runner treats 'over-cap' as
// "skip for now".
export const modelErrorKinds = [
  'no-key',
  'auth',
  'billing',
  'rate-limit',
  'unavailable',
  'timeout',
  'bad-request',
  'invalid-reply',
  'over-cap',
  'cancelled',
] as const;
export const modelErrorKind = z.enum(modelErrorKinds);
export type ModelErrorKind = z.infer<typeof modelErrorKind>;

const count = z.number().int().nonnegative();

// One row of the usage ledger: a request sent to a provider. No prompt or reply text, ever.
export const modelCall = z.object({
  at: count,
  job: z.string().min(1),
  tier: modelTier,
  provider: modelProvider,
  model: z.string().min(1),
  inputTokens: count,
  cachedTokens: count,
  outputTokens: count,
  latencyMs: count,
  // null when the model has no known price.
  costUsd: z.number().nonnegative().nullable(),
  outcome: z.union([z.literal('ok'), modelErrorKind]),
});
export type ModelCall = z.infer<typeof modelCall>;

export const usageTotals = z.object({
  calls: count,
  errors: count,
  inputTokens: count,
  cachedTokens: count,
  outputTokens: count,
  costUsd: z.number().nonnegative(),
  // Calls to models with no known price, left out of costUsd.
  unpricedCalls: count,
});
export type UsageTotals = z.infer<typeof usageTotals>;

export const capWarning = z.object({
  // The calendar month, e.g. '2026-10'.
  month: z.string().regex(/^\d{4}-\d{2}$/),
  at: count,
  spentUsd: z.number().nonnegative(),
  capUsd: z.number().positive(),
});
export type CapWarning = z.infer<typeof capWarning>;

// The Usage page: this month's spend, in the User's local time.
export const usageSummary = z.object({
  month: z.string(),
  today: usageTotals,
  thisMonth: usageTotals,
  byDay: z.array(usageTotals.extend({ day: z.string() })),
  byJob: z.array(usageTotals.extend({ job: z.string() })),
  byProvider: z.array(usageTotals.extend({ provider: z.string() })),
  monthlyCapUsd: z.number().positive().nullable(),
  capWarning: capWarning.nullable(),
});
export type UsageSummary = z.infer<typeof usageSummary>;

// What Settings → Ares → Test shows.
export const modelTestResult = z.object({
  reply: z.string(),
  provider: modelProvider,
  model: z.string(),
  latencyMs: count,
  costUsd: z.number().nonnegative().nullable(),
});
export type ModelTestResult = z.infer<typeof modelTestResult>;
