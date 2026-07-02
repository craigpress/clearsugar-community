import { NextResponse } from "next/server";
import { loadJSON, saveJSON } from "@/lib/local-store";
import { requireApiAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

const SNOOZE_KEY = "push/snooze-state.json";

export interface SnoozeState {
  snoozedUntil: number;           // epoch ms — 0 means no timed snooze
  snoozedCategories: string[];    // e.g. ["low", "high", "urgentLow", "urgentHigh"] or ["all"]
  snoozedBy: string;              // device name
  untilRange: boolean;            // true = clear when glucose returns to 70-250
}

const EMPTY_SNOOZE: SnoozeState = {
  snoozedUntil: 0,
  snoozedCategories: [],
  snoozedBy: "",
  untilRange: false,
};

export async function loadSnoozeState(): Promise<SnoozeState> {
  const raw = await loadJSON<Partial<SnoozeState>>(SNOOZE_KEY, {});
  return {
    snoozedUntil: typeof raw?.snoozedUntil === "number" ? raw.snoozedUntil : 0,
    snoozedCategories: Array.isArray(raw?.snoozedCategories) ? raw.snoozedCategories : [],
    snoozedBy: typeof raw?.snoozedBy === "string" ? raw.snoozedBy : "",
    untilRange: typeof raw?.untilRange === "boolean" ? raw.untilRange : false,
  };
}

export async function saveSnoozeState(state: SnoozeState): Promise<void> {
  await saveJSON(SNOOZE_KEY, state);
}

/**
 * POST /api/alerts/snooze
 *
 * Snooze glucose alerts for a duration or until glucose returns to range.
 *
 * Body: {
 *   duration?: number,        // minutes (30, 60, 120, 240)
 *   untilRange?: boolean,     // snooze until glucose returns to 70-250
 *   categories?: string[],    // specific categories to snooze, or omit for all
 *   device?: string           // device name (for audit trail)
 * }
 */
export async function POST(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  try {
    const body = await req.json();
    const duration: number = body.duration ?? 60;
    const untilRange: boolean = body.untilRange ?? false;
    const categories: string[] = body.categories ?? ["all"];
    const device: string = body.device ?? "unknown";

    const state: SnoozeState = {
      snoozedUntil: untilRange ? 0 : Date.now() + duration * 60 * 1000,
      snoozedCategories: categories,
      snoozedBy: device,
      untilRange,
    };

    await saveSnoozeState(state);

    return NextResponse.json({
      snoozed: true,
      ...state,
      expiresIn: untilRange ? "until in range" : `${duration} minutes`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** GET /api/alerts/snooze — check current snooze status */
export async function GET(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  const state = await loadSnoozeState();
  const now = Date.now();
  const isActive =
    state.untilRange ||
    (state.snoozedUntil > 0 && state.snoozedUntil > now);

  return NextResponse.json({
    active: isActive,
    ...state,
    ...(state.snoozedUntil > 0 && { remainingMs: Math.max(0, state.snoozedUntil - now) }),
  });
}

/** DELETE /api/alerts/snooze — cancel snooze early */
export async function DELETE(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  await saveSnoozeState(EMPTY_SNOOZE);
  return NextResponse.json({ cancelled: true });
}
