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

const BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";

const CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL ?? "qwen3.5:9b";
const CHAT_NUM_CTX = Number(process.env.OLLAMA_CHAT_NUM_CTX ?? 4096);
/**
 * qwen3.5 is a reasoning model: with thinking on it can burn the whole token
 * budget on `<think>` and return an empty answer. Off by default; set
 * OLLAMA_CHAT_THINK=true to re-enable.
 */
const CHAT_THINK = (process.env.OLLAMA_CHAT_THINK ?? "false") === "true";

const SUMMARY_MODEL = process.env.OLLAMA_SUMMARY_MODEL ?? "qwen3.5:2b";
const SUMMARY_NUM_CTX = Number(process.env.OLLAMA_SUMMARY_NUM_CTX ?? 4096);

/** Cold model load + generation can take a while on modest hardware. */
const TIMEOUT_MS = 120_000;

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
};

type OllamaChatResponse = {
  model: string;
  message?: { role: string; content: string; thinking?: string };
  total_duration?: number;
  eval_count?: number;
  eval_duration?: number;
};

type CompleteOptions = {
  model: string;
  messages: ChatMessage[];
  numCtx: number;
  think: boolean;
  temperature?: number;
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
  });
  return reply.trim();
}

export const ollamaConfig = {
  baseUrl: BASE_URL,
  chatModel: CHAT_MODEL,
  chatNumCtx: CHAT_NUM_CTX,
  chatThink: CHAT_THINK,
  summaryModel: SUMMARY_MODEL,
} as const;
