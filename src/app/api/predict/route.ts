import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { join } from "path";
import { requireApiAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

const PREDICT_URL = process.env.CLEARSUGAR_PREDICT_URL;
const PREDICT_TOKEN = process.env.CLEARSUGAR_PREDICT_TOKEN || "";

/**
 * Server-side ML prediction endpoint.
 * Proxies to the ONNX prediction microservice (CLEARSUGAR_PREDICT_URL)
 * which runs the actual trained LightGBM models for each 5-min interval.
 */
export async function POST(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;
  try {
    const { features, horizon } = await req.json();

    if (!features || !horizon || horizon < 5 || horizon > 180) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    if (!PREDICT_URL) {
      return NextResponse.json(
        { error: "Prediction not configured (missing CLEARSUGAR_PREDICT_URL)" },
        { status: 503 }
      );
    }

    // Call the ONNX prediction server
    const res = await fetch(`${PREDICT_URL}/predict`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PREDICT_TOKEN}`,
      },
      body: JSON.stringify({ features, horizon }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `Predict server: ${res.status} ${text}` },
        { status: 502 }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    // Fallback: if predict server is unreachable, return error
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Cannot reach predict server: ${message}` },
      { status: 502 }
    );
  }
}

export async function GET(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  const modelDir = join(process.cwd(), "public", "models");
  const metaPath = join(modelDir, "meta.json");
  try {
    const meta = JSON.parse(await readFile(metaPath, "utf-8"));
    return NextResponse.json({ available: true, horizons: meta.horizons || [], trainedAt: meta.trainedAt });
  } catch {
    return NextResponse.json({ available: false });
  }
}
