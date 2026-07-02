import { NextResponse } from "next/server";
import { loadJSON } from "@/lib/local-store";
import { requireApiAuth } from "@/lib/api-auth";
import type { FeedbackRecord } from "@/lib/prediction/advisor-types";

export const dynamic = "force-dynamic";

/**
 * GET /api/advisor/status — read-only view of the advisor's last fired action
 * for the dashboard "Advisor Status" strip. Returns the EXACT AdvisoryAction
 * recorded at fire time (from advisor/feedback.json) — never recomputes, so the
 * dashboard can't become a third divergent prediction surface.
 */
export async function GET(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  const [records, health] = await Promise.all([
    loadJSON<FeedbackRecord[]>("advisor/feedback.json", []),
    loadJSON<{ lastRunAt?: number; mode?: string; deliveryFailures?: number }>(
      "advisor/delivery-health.json",
      {}
    ),
  ]);
  const last = records.length > 0 ? records[records.length - 1] : null;

  return NextResponse.json({
    lastFired: last
      ? { firedAt: last.firedAt, ciqMode: last.ciqMode, advisory: last.advisory }
      : null,
    advisorMode: health.mode ?? null,
    advisorLastRunAt: health.lastRunAt ?? null,
    deliveryFailures: health.deliveryFailures ?? null,
  });
}
