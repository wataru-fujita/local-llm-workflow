/**
 * Minimal Ollama client.
 *
 * Each capability is an independent async function so later phases can compose
 * or swap them (see docs/01_仕様書.md 4.1).
 *   chat()           - user-facing answers        (OLLAMA_CHAT_MODEL)
 *   summaryComplete() - compression / extraction  (OLLAMA_SUMMARY_MODEL)
 *   embed()          - see ./embeddings.ts
 */

import { withRetry } from "./retry";
import { calibrate } from "./tokens";

const BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";

const CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL ?? "qwen3.5:9b";
const CHAT_NUM_CTX = Number(process.env.OLLAMA_CHAT_NUM_CTX ?? 4096);
/**
 * qwen3.5 is a reasoning model: with thinking on it can burn the whole token
 * budget on `<think>` and return an empty answer. Off by default; set
 * OLLAMA_CHAT_THINK=true to re-enable.
 */
const CHAT_THINK = (process.env.OLLAMA_CHAT_THINK ?? "false") === "true";

/**
 * Tokens reserved for the answer. Ollama's default num_predict is "until the
 * context runs out", so without this the prompt and the answer compete for the
 * same window: as history grew, replies got shorter and eventually stopped
 * mid-sentence. Reserving the tail of the window makes the answer length a
 * constant instead of a leftover.
 */
const CHAT_MAX_OUTPUT_TOKENS = Number(
  process.env.OLLAMA_CHAT_MAX_OUTPUT_TOKENS ?? 1024,
);
/** Slack for the chat template and tokeniser drift. */
const CHAT_PROMPT_SAFETY_TOKENS = Number(
  process.env.OLLAMA_CHAT_PROMPT_SAFETY_TOKENS ?? 192,
);

/**
 * The only number callers should build a prompt against. Everything above this
 * belongs to the answer; Ollama silently drops overflow off the *front* of the
 * prompt, so exceeding it loses the start of the conversation without warning.
 */
export const PROMPT_BUDGET_TOKENS = Math.max(
  512,
  CHAT_NUM_CTX - CHAT_MAX_OUTPUT_TOKENS - CHAT_PROMPT_SAFETY_TOKENS,
);

const SUMMARY_MODEL = process.env.OLLAMA_SUMMARY_MODEL ?? "qwen3.5:9b";
const SUMMARY_MAX_OUTPUT_TOKENS = Number(
  process.env.OLLAMA_SUMMARY_MAX_OUTPUT_TOKENS ?? 768,
);

/**
 * Summary context length.
 *
 * When the summary job runs on the *same* model as chat, this MUST match
 * CHAT_NUM_CTX: Ollama keys a loaded model on its context length, so a
 * different num_ctx makes it tear the model down and load it again - which is
 * the entire cost we avoid by reusing the chat model. Measured on this machine:
 * summarising on the 2b costs 69.2s per compaction turn (28.4s of it pure model
 * loading), against 50.1s when the 9b stays resident. The env var is ignored
 * rather than obeyed here, because obeying it would silently undo that.
 */
const SUMMARY_NUM_CTX =
  SUMMARY_MODEL === CHAT_MODEL
    ? CHAT_NUM_CTX
    : Number(process.env.OLLAMA_SUMMARY_NUM_CTX ?? 4096);

/**
 * Cold model load + generation can take a while on modest hardware, and the
 * output reserve is now the binding limit rather than the leftover context:
 * 2048 tokens at ~31 tok/s is ~66s of generation before you add prefill and a
 * possible ~19s model load. The old 120s ceiling left almost no margin, so a
 * long answer could be killed by the timeout instead of finishing.
 */
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 300_000);

export type ChatRole = "system" | "user" | "assistant";
export type ChatMessage = { role: ChatRole; content: string };

export type ChatResult = {
  reply: string;
  /** Reasoning trace, when thinking is enabled; null otherwise. */
  thinking: string | null;
  model: string;
  /** Wall time Ollama reports for the whole request. */
  totalDurationMs: number;
  /** Number of tokens generated. */
  evalCount: number;
  /** Generation speed, or null when Ollama did not report timing. */
  tokensPerSecond: number | null;
  /** Real prompt size as counted by the model's own tokeniser. */
  promptEvalCount: number;
  /** Why generation stopped. "length" means the answer was cut off. */
  doneReason: string | null;
  /** True when the answer hit the output cap rather than finishing. */
  truncated: boolean;
};

type OllamaChatResponse = {
  model: string;
  message?: { role: string; content: string; thinking?: string };
  total_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  prompt_eval_count?: number;
  done_reason?: string;
};

type CompleteOptions = {
  model: string;
  messages: ChatMessage[];
  numCtx: number;
  think: boolean;
  temperature?: number;
  maxOutputTokens?: number;
};

/**
 * One round-trip `/api/chat` completion (non-streaming), with a couple of
 * retries for transient network / 5xx failures (phase 7). Throws on timeout,
 * a persistent failure, or a non-2xx response so callers can surface a message.
 */
async function complete(opts: CompleteOptions): Promise<ChatResult> {
  return withRetry(async () => {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: false,
        think: opts.think,
        options: {
          num_ctx: opts.numCtx,
          ...(opts.maxOutputTokens != null
            ? { num_predict: opts.maxOutputTokens }
            : {}),
          ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Ollama responded ${res.status}: ${detail.slice(0, 200)}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    const evalCount = data.eval_count ?? 0;
    const evalDuration = data.eval_duration ?? 0;
    const promptEvalCount = data.prompt_eval_count ?? 0;

    // Ground-truth feedback for the token estimator (see ./tokens.ts).
    calibrate(opts.messages, promptEvalCount);

    return {
      reply: data.message?.content ?? "",
      thinking: data.message?.thinking ?? null,
      model: data.model,
      totalDurationMs: Math.round((data.total_duration ?? 0) / 1e6),
      evalCount,
      tokensPerSecond:
        evalDuration > 0
          ? Number((evalCount / (evalDuration / 1e9)).toFixed(1))
          : null,
      promptEvalCount,
      doneReason: data.done_reason ?? null,
      truncated: data.done_reason === "length",
    };
  });
}

/**
 * User-facing chat completion with the response model. Retries once if the
 * model returns an empty answer (a "broken output" per docs/03 phase 7).
 */
export async function chat(messages: ChatMessage[]): Promise<ChatResult> {
  const call = () =>
    complete({
      model: CHAT_MODEL,
      messages,
      numCtx: CHAT_NUM_CTX,
      think: CHAT_THINK,
      maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
    });

  const first = await call();
  if (first.reply.trim()) return first;
  return call();
}

/**
 * Run a single prompt through the fast summary model (thinking off, low
 * temperature). Used for context compression and fact extraction (phase 4).
 * Returns the plain text answer.
 */
export async function summaryComplete(prompt: string): Promise<string> {
  const { reply } = await complete({
    model: SUMMARY_MODEL,
    messages: [{ role: "user", content: prompt }],
    numCtx: SUMMARY_NUM_CTX,
    think: false,
    temperature: 0.2,
    maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
  });
  return reply.trim();
}

export const ollamaConfig = {
  baseUrl: BASE_URL,
  chatModel: CHAT_MODEL,
  chatNumCtx: CHAT_NUM_CTX,
  chatThink: CHAT_THINK,
  chatMaxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
  promptBudgetTokens: PROMPT_BUDGET_TOKENS,
  summaryModel: SUMMARY_MODEL,
} as const;
