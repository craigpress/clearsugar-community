import { withMealRoute } from "@/lib/meals/profile-route";
import { NextResponse } from "next/server";
import { requireIdentity } from "@/lib/patient-auth";
import { loadPhoto } from "@/lib/meals/photos";

export const dynamic = "force-dynamic";

/**
 * GET /api/meals/photo/[id] — serve a stored meal photo.
 *
 * 200 image/jpeg · 401 unauthenticated · 403 machine key · 404 unknown id
 *
 * Any *person* may view (parents read the dashboard, decision 4), but never the
 * shared `x-api-key`, and never `public/` — this is a photo of a minor on a box
 * with no encryption at rest (risk 6), so it is served only behind a personal
 * credential and told not to be cached anywhere. `loadPhoto` returns null for an
 * id that is not a UUID, so the URL segment can never reach a path.
 */
async function handleGET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireIdentity(req);
  if (!("sub" in auth)) return auth;

  const { id } = await params;
  const bytes = await loadPhoto(id);
  if (!bytes) {
    return NextResponse.json({ error: "Photo not found" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store",
      "Content-Disposition": "inline",
      // The bytes came off a stripped JPEG, but a sniffed content type is one
      // more way a stored file becomes something executable in a browser.
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export const GET = withMealRoute(handleGET, false);
