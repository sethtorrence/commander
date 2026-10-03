import type { ModelProvider } from '@commander/domain';
import type { TokenUsage } from './provider';

// US dollars per 1M tokens. Cached input is part of the input count, billed at its own rate.
export type Price = { input: number; cachedInput: number; output: number };

// Z.ai's published prices (docs.z.ai/guides/overview/pricing, checked 2026-10-01). The cached rate
// is labelled "limited-time", so check it when the bill looks off.
export const PRICES: Record<ModelProvider, Record<string, Price>> = {
  zai: {
    'glm-5.3-flash': { input: 0.15, cachedInput: 0.03, output: 0.5 },
  },
};

export function priceOf(provider: ModelProvider, model: string): Price | null {
  return PRICES[provider][model.toLowerCase()] ?? null;
}

// What a call cost, or null for a model with no known price (e.g. a local server).
export function costOf(provider: ModelProvider, model: string, usage: TokenUsage): number | null {
  const price = priceOf(provider, model);
  if (!price) return null;
  const cached = Math.min(usage.cachedTokens, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  return (
    (uncached * price.input + cached * price.cachedInput + usage.outputTokens * price.output) / 1_000_000
  );
}
