/** Small retry helper for transient Ollama / network failures (phase 7). */

export type RetryOptions = {
  retries?: number;
  /** Base backoff in ms; doubled each attempt. */
  backoffMs?: number;
  /** Return true to retry on this error. Default: retry everything. */
  isRetryable?: (err: unknown) => boolean;
};

const TRANSIENT =
  /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|socket hang up|fetch failed|network|The operation was aborted|aborted|terminated|HTTP 5\d\d|responded 5\d\d/i;

/** Default heuristic: network blips and 5xx are retryable; 4xx and logic errors are not. */
export function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT.test(msg);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 2;
  const backoffMs = opts.backoffMs ?? 400;
  const retryable = opts.isRetryable ?? isTransient;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !retryable(err)) break;
      await new Promise((r) => setTimeout(r, backoffMs * 2 ** attempt));
    }
  }
  throw lastErr;
}
