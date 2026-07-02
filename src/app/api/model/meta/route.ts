import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

const PREDICT_URL = process.env.CLEARSUGAR_PREDICT_URL;

export async function GET(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  if (!PREDICT_URL) {
    return NextResponse.json(
      { error: "Prediction server not configured" },
      { status: 503 }
    );
  }

  try {
    const res = await fetch(`${PREDICT_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return NextResponse.json({ available: false }, { status: 200 });
    }
    const data = await res.json();
    // Forward the full meta object (trainedAt, trainingDays, validationRMSE, etc.)
    return NextResponse.json({
      ...data.meta,
      available: true,
      models: data.models,
    });
  } catch {
    return NextResponse.json({ available: false }, { status: 200 });
  }
}
