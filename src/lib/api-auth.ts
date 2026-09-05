import { auth } from "@/lib/auth";
import { jwtVerify } from "jose";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

/** Constant-time string comparison (length-safe). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Who the caller is, when the request carried a personal credential. */
export interface AuthIdentity {
  /** Subject claim — the username (see api/auth/mobile/token). Stable across
   *  APNs token rotation, app reinstall, and device replacement, which is what
   *  makes it usable as a durable identity for push routing. */
  sub: string;
  name?: string;
  role?: string;
}

/**
 * Returns the caller's identity, or null for machine callers (X-API-Key), which
 * are shared and identify nobody.
 *
 * Separate from requireApiAuth so existing `const denied = await
 * requireApiAuth(req); if (denied) return denied;` call sites keep working
 * unchanged — only routes that care who is calling opt in.
 *
 * Never use this for authorization; it does not verify the caller is allowed to
 * do anything. Call requireApiAuth first, then this for attribution.
 */
export async function getAuthIdentity(req: Request): Promise<AuthIdentity | null> {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const secret = process.env.MOBILE_JWT_SECRET;
    if (!secret) return null;
    try {
      const key = new TextEncoder().encode(secret);
      const { payload } = await jwtVerify(authHeader.slice(7), key, {
        issuer: "clearsugar",
        audience: "clearsugar-api",
        algorithms: ["HS256"],
      });
      if (typeof payload.sub !== "string" || !payload.sub) return null;
      return {
        sub: payload.sub,
        name: typeof payload.name === "string" ? payload.name : undefined,
        role: typeof payload.role === "string" ? payload.role : undefined,
      };
    } catch {
      return null;
    }
  }

  const session = await auth();
  const who = session?.user?.name ?? session?.user?.email;
  if (who) return { sub: who, name: session?.user?.name ?? undefined, role: session?.user?.role };
  return null;
}

/**
 * Validates an API request via:
 *   1. X-API-Key header (for cron/systemd timers, machine clients)
 *   2. Authorization: Bearer <jwt> (for the mobile companion app)
 *   3. Valid NextAuth session cookie (for browser/dashboard calls)
 *
 * Auth methods are mutually exclusive: if a Bearer token is present,
 * it must be valid — an invalid/expired JWT returns 401 immediately
 * and does not fall through to session auth.
 */
export async function requireApiAuth(
  req: Request
): Promise<NextResponse | null> {
  // 1. Check API key (machine clients: timers/cron, companion apps)
  const apiKey = req.headers.get("x-api-key");
  const expectedKey = process.env.CLEARSUGAR_API_KEY;
  if (apiKey && expectedKey && safeEqual(apiKey, expectedKey)) {
    return null; // authorized
  }

  // 2. Check Bearer JWT (mobile companion tokens from /api/auth/mobile/token)
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const secret = process.env.MOBILE_JWT_SECRET;
    if (!secret) {
      // Misconfiguration — fail closed, don't silently skip
      console.error("[api-auth] MOBILE_JWT_SECRET not set — rejecting Bearer token");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    try {
      const key = new TextEncoder().encode(secret);
      await jwtVerify(authHeader.slice(7), key, {
        issuer: "clearsugar",
        audience: "clearsugar-api",
        algorithms: ["HS256"],
      });
      return null; // authorized
    } catch {
      // Invalid/expired JWT — reject immediately, don't fall through
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // 3. Fall back to session auth (browser/dashboard)
  const session = await auth();
  if (session?.user) {
    return null; // authorized — session validated by NextAuth
  }

  return NextResponse.json(
    { error: "Unauthorized" },
    { status: 401 }
  );
}
