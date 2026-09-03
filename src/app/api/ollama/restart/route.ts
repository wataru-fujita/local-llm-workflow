import { restartOllama } from "@/lib/ollama-admin";

/**
 * POST /api/ollama/restart - stop the Ollama server and wait for it to come
 * back (tray app auto-respawns; falls back to `ollama serve`).
 * No request body is read - the command is fixed / env-configured.
 */
export async function POST() {
  try {
    const result = await restartOllama();
    return Response.json(result, { status: result.ok ? 200 : 502 });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
