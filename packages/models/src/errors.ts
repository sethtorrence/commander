import type { ModelErrorKind } from '@commander/domain';

export type ModelErrorDetails = {
  // The HTTP status the provider answered with, if it answered.
  status?: number;
  // How long the provider asked us to wait before trying again.
  retryAfterMs?: number;
};

// Every failure of a model call, in provider-neutral terms. Messages never carry the API key.
export class ModelError extends Error {
  override name = 'ModelError';

  constructor(
    readonly kind: ModelErrorKind,
    message: string,
    readonly details: ModelErrorDetails = {},
  ) {
    super(message);
  }
}

// The job runner skips a job for now when the month's cap stops it.
export const isOverCap = (error: unknown): boolean =>
  error instanceof ModelError && error.kind === 'over-cap';
