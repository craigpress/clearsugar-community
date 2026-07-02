import { NextResponse } from "next/server";
import { SignJWT } from "jose";
import { getUserRole } from "@/lib/roles";
import {
  verifyPassword,
  isRateLimited,
  recordFailedAttempt,
  clearFailedAttempts,
} from "@/lib/users-store";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/mobile/token
 *
 * The companion app exchanges a username/password for a ClearSugar JWT.
 * Flow:
 *   1. App POSTs { username, password }
 *   2. We verify the credentials against the local `auth/users` store
 *   3. We sign a 7-day HS256 JWT with MOBILE_JWT_SECRET
 *
 * The iss/aud claims are stable ("clearsugar" / "clearsugar-api") so the
 * companion-app contract and requireApiAuth() verification stay in sync.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const username =
      typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";

    if (!username || !password) {
      return NextResponse.json(
        { error: "username and password required" },
        { status: 400 }
      );
    }

    const secret = process.env.MOBILE_JWT_SECRET;
    if (!secret) {
      return NextResponse.json(
        { error: "Server misconfigured" },
        { status: 500 }
      );
    }

    // Fail closed on repeated failures (same policy as web login).
    if (isRateLimited(username)) {
      return NextResponse.json(
        { error: "Too many attempts — try again later" },
        { status: 429 }
      );
    }

    const user = await verifyPassword(username, password);
    if (!user) {
      recordFailedAttempt(username);
      // Same error for unknown user and wrong password (no enumeration).
      return NextResponse.json(
        { error: "Invalid username or password" },
        { status: 401 }
      );
    }

    clearFailedAttempts(username);

    const role = getUserRole(user.role);
    const key = new TextEncoder().encode(secret);
    const jti = crypto.randomUUID();
    const jwt = await new SignJWT({ sub: user.username, name: user.username, role })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("7d")
      .setJti(jti)
      .setIssuer("clearsugar")
      .setAudience("clearsugar-api")
      .sign(key);

    return NextResponse.json({
      token: jwt,
      user: { username: user.username, name: user.username, role },
    });
  } catch (err) {
    console.error("[mobile/token] unhandled error", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
