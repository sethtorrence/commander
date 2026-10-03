// One model interface for Ares, with a provider adapter per service behind it (Z.ai for now).
export { isOverCap, ModelError, type ModelErrorDetails } from './errors';
export { createMemoryLedger, type MemoryLedger, type UsageLedger } from './ledger';
export {
  type CompleteRequest,
  type Completion,
  createModelClient,
  type ModelClient,
  type ModelClientOptions,
  type Usage,
} from './model-client';
export { costOf, PRICES, type Price, priceOf } from './prices';
export type {
  ChatMessage,
  ModelProviderAdapter,
  ProviderReply,
  ProviderRequest,
  TokenUsage,
} from './provider';
export { createZaiProvider, type ZaiProviderOptions } from './zai';
