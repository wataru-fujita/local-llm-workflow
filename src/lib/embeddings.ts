/**
 * Ollama embedding wrapper (phase 3).
 *
 * Uses OLLAMA_EMBED_MODEL (bge-m3, 1024 dims) via `/api/embed`. Keep the same
 * model for writes and queries — the vector DB column has a fixed dimension.
 */

import { withRetry } from "./retry";

const BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "bge-m3";
const EMBED_TIMEOUT_MS = 30_000;

/** Embed one string into a dense vector. Throws on failure. */
export async function embed(text: string): Promise<number[]> {
  const [vec] = await embedBatch([text]);
  return vec;
}

/** Embed several strings in one call (retries transient failures). */
export function embedBatch(texts: string[]): Promise<number[][]> {
  return withRetry(async () => {
    const res = await fetch(`${BASE_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `Ollama embed responded ${res.status}: ${detail.slice(0, 200)}`,
      );
    }

    const data = (await res.json()) as { embeddings?: number[][] };
    if (!data.embeddings?.length || !data.embeddings[0]?.length) {
      throw new Error("Ollama embed returned no vector");
    }
    return data.embeddings;
  });
}

export const embedConfig = { model: EMBED_MODEL } as const;
