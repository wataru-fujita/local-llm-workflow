import { checkHealth } from "@/lib/ollama-admin";

/** GET /api/ollama/health - Ollama liveness, latency, loaded models. */
export async function GET() {
  return Response.json(await checkHealth());
}
