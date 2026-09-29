import { withMealRoute } from "@/lib/meals/profile-route";
import { NextResponse } from "next/server";
import { requireIdentity } from "@/lib/patient-auth";
import {
  MAX_PHOTO_BYTES,
  PhotoInvalidError,
  PhotoTooLargeError,
  savePhoto,
} from "@/lib/meals/photos";

export const dynamic = "force-dynamic";

/**
 * POST /api/meals/photo — store one meal photo (feature C, section 4c).
 *
 * Body: { clientId, imageBase64, takenAt? }  — JSON, not multipart: base64 is
 * what the iOS client and a browser canvas both produce without a parser, and
 * the 1.5 MB ceiling keeps the inflated body well inside Next's default limit.
 *
 * 201 { photoId, bytes, width, height } · 200 the same on an idempotent replay
 * 400 not a JPEG / bad base64 · 401 unauthenticated · 403 unauthorized role
 * 413 over the size limit
 *
 * Stored in the authenticated request's selected child profile.
 */
async function handlePOST(req: Request) {
  const auth = await requireIdentity(req);
  if (!("sub" in auth)) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "body must be a JSON object" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  try {
    const saved = await savePhoto({
      clientId: typeof b.clientId === "string" ? b.clientId : "",
      imageBase64: typeof b.imageBase64 === "string" ? b.imageBase64 : "",
      takenAt: (b.takenAt as string | number | null | undefined) ?? undefined,
      sub: auth.sub,
    });
    return NextResponse.json(
      {
        photoId: saved.photoId,
        bytes: saved.bytes,
        width: saved.width,
        height: saved.height,
      },
      { status: saved.replayed ? 200 : 201 }
    );
  } catch (err) {
    if (err instanceof PhotoTooLargeError) {
      return NextResponse.json(
        { error: err.message, maxBytes: MAX_PHOTO_BYTES },
        { status: 413 }
      );
    }
    if (err instanceof PhotoInvalidError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[meals/photo] POST failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const POST = withMealRoute(handlePOST, true);
