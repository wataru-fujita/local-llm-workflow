import {
  compactConversation,
  getConversation,
  statsFor,
} from "@/lib/conversation";

/**
 * POST /api/conversation/compact
 * Body: { force?: boolean }  (default true - emergency/manual compaction)
 *
 * Phase 4/5: manual "圧縮" button. force=true keeps only the last turn verbatim.
 */
export async function POST(request: Request) {
  let force = true;
  try {
    const body = (await request.json()) as { force?: unknown };
    if (typeof body.force === "boolean") force = body.force;
  } catch {
    /* no body -> force compaction */
  }

  try {
    const result = await compactConversation(force);
    const stats = statsFor(await getConversation());
    return Response.json({ ok: true, compacted: result !== null, result, stats });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const conn = /ECONNREFUSED|fetch failed|timeout|aborted/i.test(detail);
    return Response.json(
      {
        error: conn
          ? "Ollama に接続できませんでした（要約モデルの呼び出しに失敗）。"
          : `圧縮に失敗しました: ${detail}`,
      },
      { status: 502 },
    );
  }
}
