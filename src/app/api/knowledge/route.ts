import {
  addKnowledge,
  clearKnowledge,
  knowledgeCount,
  listKnowledge,
} from "@/lib/knowledge";

/** GET /api/knowledge - list stored knowledge + count. */
export async function GET() {
  try {
    const [items, count] = await Promise.all([
      listKnowledge(),
      knowledgeCount(),
    ]);
    return Response.json({ items, count });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** POST /api/knowledge  Body: { text: string, source?: string } */
export async function POST(request: Request) {
  let body: { text?: unknown; source?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON を読み取れませんでした。" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return Response.json({ error: "text を入力してください。" }, { status: 400 });
  }
  const source = typeof body.source === "string" ? body.source : "manual";

  try {
    await addKnowledge(text, source);
    return Response.json({ ok: true, count: await knowledgeCount() });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const conn = /ECONNREFUSED|fetch failed|timeout|aborted/i.test(detail);
    return Response.json(
      {
        error: conn
          ? "Ollama に接続できませんでした（埋め込み生成に失敗）。"
          : `知識の登録に失敗しました: ${detail}`,
      },
      { status: 502 },
    );
  }
}

/** DELETE /api/knowledge - wipe the store. */
export async function DELETE() {
  try {
    await clearKnowledge();
    return Response.json({ ok: true, count: 0 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
