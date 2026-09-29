import { NextResponse } from "next/server";
import { getAuthIdentity, requireApiAuth } from "@/lib/api-auth";
import { findUser } from "@/lib/users-store";

export async function requireIdentity(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;
  const identity = await getAuthIdentity(req);
  const user = identity?.sub ? await findUser(identity.sub) : null;
  if (!user) return NextResponse.json({ error: "A current personal account is required" }, { status: 403 });
  return { sub: user.username, role: user.role };
}
