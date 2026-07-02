import { NextResponse } from "next/server";
import { loadJSON } from "@/lib/local-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — public, unauthenticated liveness endpoint for an external
 * watchdog / uptime monitor. Reports how long since the action-advisor cron
 * last completed a run. The advisor systemd timer fires every 5 min, so
 * advisorAgeMin climbing past ~15 means the advisor has SILENTLY stopped — the
 * failure class behind the ~2-month ML dormancy, where alerting quietly died and
 * nobody knew. If the whole app/host is down, this endpoint is unreachable,
 * which is the other half of the same signal.
 *
 * Intentionally NO auth (so a plain external monitor can poll it) and NO PHI —
 * it exposes only timing/liveness, never a glucose value. Reads a single local
 * file; does not touch Nightscout, so it is cheap to poll every 5 min.
 *
 * Also reports the ML predict-server (CLEARSUGAR_PREDICT_URL) liveness as
 * `mlOk` — the ensemble curve silently degrades to physiological when the
 * service dies, so monitor `mlOk` to catch a quiet outage. `mlOk` does NOT
 * affect `ok`: ML down degrades the displayed curve, never alerting.
 */
const PREDICT_URL = process.env.CLEARSUGAR_PREDICT_URL;

async function checkPredictServer(): Promise<{
  mlOk: boolean;
  mlModelAgeDays: number | null;
  mlModelVersion: string | null;
}> {
  if (!PREDICT_URL) return { mlOk: false, mlModelAgeDays: null, mlModelVersion: null };
  try {
    const res = await fetch(`${PREDICT_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { mlOk: false, mlModelAgeDays: null, mlModelVersion: null };
    const data = (await res.json()) as {
      status?: string;
      modelVersion?: string;
      meta?: { trainedAt?: string };
    };
    const trainedAt = data.meta?.trainedAt ? Date.parse(data.meta.trainedAt) : NaN;
    return {
      mlOk: data.status === "ok",
      mlModelAgeDays: Number.isFinite(trainedAt)
        ? Math.round((Date.now() - trainedAt) / 86_400_000)
        : null,
      mlModelVersion: data.modelVersion ?? null,
    };
  } catch {
    return { mlOk: false, mlModelAgeDays: null, mlModelVersion: null };
  }
}

export async function GET() {
  const now = Date.now();
  const health = await loadJSON<{
    lastRunAt?: number;
    mode?: string;
    fired?: number;
    pushed?: number;
    deliveryFailures?: number;
  }>("advisor/delivery-health.json", {});

  const lastRunAt = health.lastRunAt ?? null;
  const advisorAgeMin =
    lastRunAt != null ? Math.round((now - lastRunAt) / 60_000) : null;
  // Healthy = the advisor completed a run within the last 15 min (3 cron cycles).
  const ok = advisorAgeMin != null && advisorAgeMin <= 15;

  const ml = await checkPredictServer();

  return NextResponse.json({
    ok,
    advisorAgeMin,
    advisorLastRunAt: lastRunAt,
    advisorMode: health.mode ?? null,
    deliveryFailures: health.deliveryFailures ?? null,
    ...ml,
    now,
  });
}
