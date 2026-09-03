import { chat, type ChatMessage } from "@/lib/ollama";
import { embed } from "@/lib/embeddings";
import {
  addMessage,
  approxTokenCount,
  getConversation,
  getPromptMessages,
  maybeCompact,
  statsFor,
} from "@/lib/conversation";
import { searchKnowledgeByVector, type KnowledgeHit } from "@/lib/knowledge";

/**
 * POST /api/chat
 * Body: { message: string }
 *
 * Streams NDJSON progress so the UI (and the phase-6.5 visualisation) tracks
 * the *actual* pipeline rather than a timer. One JSON object per line:
 *
 *   {type:"stage", stage, status:"start"|"end", ms?, detail?}
 *   {type:"done",  reply, model, stats, retrieved, compaction, ...}
 *   {type:"error", error}
 *
 * Pipeline stages (docs/01_仕様書.md 4.1):
 *   input → embed → retrieve → prompt → generate → persist → compact
 */

type Stage =
  | "input"
  | "embed"
  | "retrieve"
  | "prompt"
  | "generate"
  | "persist"
  | "compact";

export async function POST(request: Request) {
  let body: { message?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "リクエストボディを JSON として読み取れませんでした。" },
      { status: 400 },
    );
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return Response.json(
      { error: "message フィールドに文字列を入れてください。" },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));

      /** Time one stage, emitting start/end events around it. */
      async function step<T>(
        stage: Stage,
        detail: string,
        fn: () => Promise<T>,
      ): Promise<T> {
        send({ type: "stage", stage, status: "start", detail });
        const t0 = Date.now();
        try {
          return await fn();
        } finally {
          send({
            type: "stage",
            stage,
            status: "end",
            ms: Date.now() - t0,
          });
        }
      }

      try {
        send({
          type: "stage",
          stage: "input",
          status: "start",
          detail: `${message.length} 文字`,
        });
        send({
          type: "stage",
          stage: "input",
          status: "end",
          ms: 0,
          detail: `約 ${approxTokenCount(message)} tokens`,
        });

        // 1. embed the question, 2. search long-term knowledge.
        // RAG is optional: a failure here must not block the answer.
        let retrieved: KnowledgeHit[] = [];
        try {
          const vector = await step("embed", "質問をベクトル化", () =>
            embed(message),
          );
          send({
            type: "stage",
            stage: "embed",
            status: "end",
            detail: `${vector.length} 次元`,
          });
          retrieved = await step("retrieve", "長期知識を検索", () =>
            searchKnowledgeByVector(vector),
          );
          send({
            type: "stage",
            stage: "retrieve",
            status: "end",
            detail: `${retrieved.length} 件ヒット`,
          });
        } catch (err) {
          console.warn("[chat] RAG failed, continuing without it:", err);
          send({
            type: "stage",
            stage: "retrieve",
            status: "end",
            detail: "検索スキップ",
          });
        }

        // 3. assemble the prompt.
        const messages = await step("prompt", "プロンプトを構成", async () => {
          const history = await getPromptMessages();
          const msgs: ChatMessage[] = [
            ...(retrieved.length
              ? [
                  {
                    role: "system" as const,
                    content:
                      "次の参考情報を必要に応じて回答に使ってください。関係なければ無視してください。\n" +
                      retrieved.map((r, i) => `[${i + 1}] ${r.text}`).join("\n"),
                  },
                ]
              : []),
            ...history,
            { role: "user", content: message },
          ];
          return msgs;
        });
        send({
          type: "stage",
          stage: "prompt",
          status: "end",
          detail: `${messages.length} メッセージ`,
        });

        // 4. generate.
        const result = await step("generate", "応答を生成", () => chat(messages));
        if (!result.reply.trim()) {
          send({
            type: "error",
            error:
              "モデルが空の応答を返しました。`.env.local` の OLLAMA_CHAT_THINK や num_ctx を見直してください。",
          });
          controller.close();
          return;
        }
        send({
          type: "stage",
          stage: "generate",
          status: "end",
          detail: `${result.evalCount} tokens${
            result.tokensPerSecond ? ` · ${result.tokensPerSecond} tok/s` : ""
          }`,
        });

        // 5. persist the turn.
        await step("persist", "履歴に保存", async () => {
          await addMessage("user", message);
          await addMessage("assistant", result.reply);
        });

        // 6. compress if over budget.
        let compaction = null;
        try {
          compaction = await step("compact", "コンテキストを確認", () =>
            maybeCompact(),
          );
          send({
            type: "stage",
            stage: "compact",
            status: "end",
            detail: compaction
              ? `${compaction.summarizedMessages} 件を要約`
              : "圧縮不要",
          });
        } catch (err) {
          console.warn("[chat] auto-compaction failed:", err);
        }

        const stats = statsFor(await getConversation());
        send({
          type: "done",
          reply: result.reply,
          model: result.model,
          totalDurationMs: result.totalDurationMs,
          evalCount: result.evalCount,
          tokensPerSecond: result.tokensPerSecond,
          stats,
          compaction: compaction
            ? {
                compactions: compaction.compactions,
                summarizedMessages: compaction.summarizedMessages,
                factsSaved: compaction.factsSaved,
              }
            : null,
          retrieved: retrieved.map((r) => ({
            text: r.text,
            distance: Number(r.distance.toFixed(3)),
          })),
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const looksLikeConnectionIssue =
          /ECONNREFUSED|fetch failed|ENOTFOUND|timed out|timeout|aborted|The operation was aborted/i.test(
            detail,
          );
        send({
          type: "error",
          error: looksLikeConnectionIssue
            ? "Ollama に接続できませんでした。`ollama serve` が起動しているか確認してください。"
            : `Ollama 呼び出しでエラーが発生しました: ${detail}`,
          connection: looksLikeConnectionIssue,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
