import { NextResponse, type NextRequest } from "next/server";
import { getPatientProfile, savePatientProfile } from "@/lib/patient-profile";
import type { PatientProfile } from "@/lib/patient-profile";
import { requireApiAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

/** GET /api/profile — returns the current patient profile */
export async function GET(request: NextRequest) {
  try {
    const denied = await requireApiAuth(request);
    if (denied) return denied;
    return NextResponse.json(await getPatientProfile());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** PUT /api/profile — saves the full patient profile */
export async function PUT(request: NextRequest) {
  try {
    const denied = await requireApiAuth(request);
    if (denied) return denied;

    const body = await request.json().catch(() => null);
    if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

    const profile: PatientProfile = {
      name: typeof body.name === "string" ? body.name : "",
      ageYears: typeof body.ageYears === "number" ? body.ageYears : null,
      cgm: typeof body.cgm === "string" ? body.cgm : "",
      pump: typeof body.pump === "string" ? body.pump : "",
      insulinNotes: typeof body.insulinNotes === "string" ? body.insulinNotes : "",
      clinicalNotes: typeof body.clinicalNotes === "string" ? body.clinicalNotes : "",
    };

    await savePatientProfile(profile);

    return NextResponse.json(profile);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
