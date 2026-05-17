import { logger } from './logger.js';

export type RetryOptions = {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  onAttempt?: (attemptNumber: number, err: unknown) => void;
  shouldRetry?: (err: unknown) => boolean;
};

export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: RetryOptions
): Promise<T> {
  const maxDelay = opts.maxDelayMs ?? 8000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const retryable = opts.shouldRetry ? opts.shouldRetry(err) : true;
      const isLast = attempt === opts.attempts;
      opts.onAttempt?.(attempt, err);
      logger.warn(
        { label, attempt, attempts: opts.attempts, retryable, err: serializeError(err) },
        'retry attempt failed'
      );
      if (!retryable || isLast) break;
      const delay = Math.min(maxDelay, opts.baseDelayMs * 2 ** (attempt - 1));
      await sleep(delay);
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serializeError(err: unknown): { message: string; name?: string } {
  if (err instanceof Error) return { message: err.message, name: err.name };
  return { message: String(err) };
}
