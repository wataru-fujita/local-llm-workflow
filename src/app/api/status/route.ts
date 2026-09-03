import { checkHealth } from "@/lib/ollama-admin";
import { getConversation, statsFor } from "@/lib/conversation";
import { knowledgeCount } from "@/lib/knowledge";

/** GET /api/status - one-shot snapshot for the admin panel. */
export async function GET() {
  const [health, conv, kCount] = await Promise.all([
    checkHealth(),
    getConversation(),
    knowledgeCount().catch(() => 0),
  ]);

  return Response.json({
    ollama: health,
    conversation: statsFor(conv),
    knowledge: { count: kCount },
  });
}
