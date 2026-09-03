import { clearAuthCookie } from "@/lib/auth";

/** POST /api/auth/logout - clear the auth cookie. */
export async function POST() {
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": clearAuthCookie() } },
  );
}
