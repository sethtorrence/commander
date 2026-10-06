import type { ReasoningEffort, TierSetting } from '@commander/domain';

// What every provider adapter (Z.ai now; Anthropic, OpenAI and a local model later) implements.
// Callers never see this: they use the model client, which picks the adapter from the tier's setting.

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type ProviderRequest = {
  // The model and where it is served.
  setting: Pick<TierSetting, 'model' | 'baseUrl'>;
  messages: ChatMessage[];
  reasoningEffort: ReasoningEffort;
  // Ask for a JSON object reply.
  json: boolean;
  signal?: AbortSignal;
};

export type TokenUsage = {
  // Every input token, cached ones included.
  inputTokens: number;
  cachedTokens: number;
  // Thinking tokens included.
  outputTokens: number;
};

export type ProviderReply = { text: string; usage: TokenUsage };

export type ModelProviderAdapter = {
  // Throws ModelError on failure.
  send(request: ProviderRequest): Promise<ProviderReply>;
  // Calls onToken as text arrives; resolves with the whole reply once the stream ends.
  stream(request: ProviderRequest, onToken: (token: string) => void): Promise<ProviderReply>;
};

// An embedding model (#73): Commander's local one now, a hosted one later. Callers use the model
// client's `embed`, which logs each call to the usage ledger.
export type EmbeddingProviderAdapter = {
  // 'local': running on this machine, so it costs nothing.
  provider: 'local';
  model: string;
  // One vector per text, in order, and the tokens read. Throws on failure.
  embed(texts: readonly string[], signal?: AbortSignal): Promise<{ vectors: Float32Array[]; tokens: number }>;
};
