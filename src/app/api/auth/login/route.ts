import {
  authCookie,
  checkPassword,
  expectedToken,
  isAuthEnabled,
} from "@/lib/auth";

/** POST /api/auth/login  Body: { password: string } */
export async function POST(req: Request) {
  if (!isAuthEnabled()) return Response.json({ ok: true });

  let password = "";
  try {
    const body = (await req.json()) as { password?: unknown };
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    /* empty */
  }

  if (!checkPassword(password)) {
    return Response.json({ error: "パスワードが違います。" }, { status: 401 });
  }

  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": authCookie(await expectedToken()) } },
  );
}
