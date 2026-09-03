import {
  getConversation,
  resetConversation,
  statsFor,
} from "@/lib/conversation";

/** GET /api/conversation - full history + stats (used to restore the UI on load). */
export async function GET() {
  const state = await getConversation();
  return Response.json({ ...state, stats: statsFor(state) });
}

/** DELETE /api/conversation - clear history and start fresh. */
export async function DELETE() {
  await resetConversation();
  const state = await getConversation();
  return Response.json({ ok: true, ...state, stats: statsFor(state) });
}
