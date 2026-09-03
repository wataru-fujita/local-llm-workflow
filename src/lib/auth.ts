/**
 * Minimal password gate (phase 6).
 *
 * Threat model: the app is only reachable on the home LAN / Tailnet. This adds
 * a single shared password so a device that wanders onto the Tailnet can't just
 * use it. Not a real user system.
 *
 * Enabled only when APP_PASSWORD is set. Uses Web Crypto so it runs in both
 * edge middleware and Node route handlers.
 */

const PASSWORD = process.env.APP_PASSWORD ?? "";
export const AUTH_COOKIE = "llmwf_auth";
export const AUTH_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function isAuthEnabled(): boolean {
  return PASSWORD.length > 0;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Opaque cookie value derived from the password. */
export function expectedToken(): Promise<string> {
  return sha256Hex(`llm-workflow:v1:${PASSWORD}`);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Is this request's auth cookie valid? (Always true when auth is disabled.) */
export async function verifyToken(token: string | undefined): Promise<boolean> {
  if (!isAuthEnabled()) return true;
  if (!token) return false;
  return timingSafeEqual(token, await expectedToken());
}

/** Does the submitted password match? */
export function checkPassword(password: string): boolean {
  if (!isAuthEnabled()) return true;
  return timingSafeEqual(password, PASSWORD);
}

export function authCookie(token: string): string {
  // No `Secure`: Tailscale Serve terminates TLS, but the app itself is plain
  // http on localhost. Tailnet-only exposure makes this acceptable.
  return `${AUTH_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${AUTH_MAX_AGE}`;
}

export function clearAuthCookie(): string {
  return `${AUTH_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}
