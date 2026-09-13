/**
 * Token accounting.
 *
 * The previous estimate lived in conversation.ts as `Math.ceil(len / 3)`. On
 * this app's own Japanese history that under-counted by ~1.7x: 8499 characters
 * came back from the model as 4676 real tokens. Combined with maybeCompact()
 * counting only `state.messages` - not the rolling summary it also sends - a
 * history the app believed was 1680 tokens was really a 4676-token prompt
 * against a 4096-token window. The prompt alone overflowed the context, so
 * answers were cut off mid-sentence and got shorter every turn.
 *
 * Two defences, because a heuristic alone will drift with the model:
 *   1. a script-aware estimate (CJK is ~2.3x denser per character than latin)
 *   2. runtime calibration - every real completion reports how many tokens the
 *      prompt actually was, so we correct the ratio against ground truth.
 */

/** Kana, CJK ideographs, and the fullwidth/CJK punctuation blocks. */
const CJK =
  /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/**
 * Tokens per character, measured against qwen3.5's tokenizer on this app's own
 * conversation log (6574 CJK + 1925 non-CJK chars = 4676 tokens). Solving for
 * the CJK rate is insensitive to the latin assumption: 1/3.5 .. 1/4.0 per latin
 * char all give ~0.63 for CJK.
 */
const CJK_TOKENS_PER_CHAR = 0.63;
const OTHER_TOKENS_PER_CHAR = 1 / 3.7;

/** Per-message chat-template overhead (role markers, separators). */
export const PER_MESSAGE_OVERHEAD_TOKENS = 5;

/**
 * Correction factor applied on top of the static estimate, learned from real
 * `prompt_eval_count` values. 1.0 until the first completion reports back.
 * Module-level so it survives within a server process; deliberately not
 * persisted, since it re-converges within a turn or two.
 */
const globalCal = globalThis as unknown as {
  __tokenCalibration?: { factor: number; samples: number };
};
const cal = (globalCal.__tokenCalibration ??= { factor: 1, samples: 0 });

/** Never let calibration swing wildly on one odd sample. */
const MIN_FACTOR = 0.6;
const MAX_FACTOR = 1.8;
/** Exponential moving average weight for each new observation. */
const EMA_ALPHA = 0.3;

/** Raw script-aware estimate for a single string, before calibration. */
function rawEstimate(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return cjk * CJK_TOKENS_PER_CHAR + other * OTHER_TOKENS_PER_CHAR;
}

/** Estimated tokens for one string. */
export function estimateTokens(text: string): number {
  return Math.ceil(rawEstimate(text) * cal.factor);
}

/**
 * Estimated tokens for a whole message list, including per-message template
 * overhead. This is the number to compare against the context budget - the old
 * code compared a subset of the messages and nothing else.
 */
export function estimateMessageTokens(
  messages: { content: string }[],
): number {
  const body = messages.reduce((n, m) => n + rawEstimate(m.content), 0);
  return Math.ceil(
    body * cal.factor + messages.length * PER_MESSAGE_OVERHEAD_TOKENS,
  );
}

/**
 * Feed a real `prompt_eval_count` back in, together with the messages that
 * produced it, so the estimate self-corrects. Called after every completion.
 */
export function calibrate(
  messages: { content: string }[],
  actualPromptTokens: number,
): void {
  if (!Number.isFinite(actualPromptTokens) || actualPromptTokens <= 0) return;
  const predictedRaw =
    messages.reduce((n, m) => n + rawEstimate(m.content), 0) +
    messages.length * PER_MESSAGE_OVERHEAD_TOKENS;
  if (predictedRaw <= 0) return;

  const observed = actualPromptTokens / predictedRaw;
  const next =
    cal.samples === 0 ? observed : cal.factor * (1 - EMA_ALPHA) + observed * EMA_ALPHA;
  cal.factor = Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, next));
  cal.samples++;
}

/** Current calibration, for the status endpoint / admin panel. */
export function calibrationState(): { factor: number; samples: number } {
  return { factor: Number(cal.factor.toFixed(3)), samples: cal.samples };
}
