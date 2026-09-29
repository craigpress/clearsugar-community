import { beforeEach, describe, expect, it, vi } from "vitest";

const pushAlertNotification = vi.fn().mockResolvedValue(undefined);
const loadSnoozeState = vi.fn();

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json" } }) } }));
vi.mock("@/lib/api-auth", () => ({ safeEqual: (a: string, b: string) => a === b }));

vi.mock("@/lib/apns", () => ({
  pushLiveActivityUpdate: vi.fn(), pushAlertNotification,
  pushSilentBackground: vi.fn(),
}));
vi.mock("@/app/api/push/register/route", () => ({
  loadLiveActivityTokens: vi.fn().mockResolvedValue({}), saveLiveActivityTokens: vi.fn(),
}));
vi.mock("@/lib/server/alert-registration", () => ({
  loadAlertTokens: vi.fn().mockResolvedValue({ "alert-only-token": { installId: "i1" } }),
}));
vi.mock("@/lib/server/alert-snooze", () => ({ loadSnoozeState, saveSnoozeState: vi.fn() }));

describe("GET /api/push/send stale sensor path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLEARSUGAR_API_KEY = "test-key";
    process.env.NIGHTSCOUT_URL = "https://nightscout.test";
    loadSnoozeState.mockResolvedValue({ snoozedUntil: 0, snoozedCategories: [], untilRange: false });
  });

  it("alerts an alert-only registration once for a repeated stale reading", async () => {
    vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
    const staleDate = Date.now() - 21 * 60_000;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [{ sgv: 0, date: staleDate }] }));
    const { GET } = await import("../route");
    const req = new Request("http://localhost/api/push/send", { headers: { "x-api-key": "test-key" } });

    await GET(req);
    await GET(req);

    expect(pushAlertNotification).toHaveBeenCalledTimes(1);
    expect(pushAlertNotification).toHaveBeenCalledWith(
      "alert-only-token", "Sensor data stopped", expect.stringContaining("21 min"),
      "GLUCOSE_WARNING", "time-sensitive",
    );
  });

  it("suppresses the wired stale alert while the stale category is snoozed", async () => {
    vi.resetModules();
    loadSnoozeState.mockResolvedValue({
      snoozedUntil: Date.now() + 60_000, snoozedCategories: ["stale"], untilRange: false,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => [{ sgv: 0, date: Date.now() - 21 * 60_000 }],
    }));
    const { GET } = await import("../route");
    await GET(new Request("http://localhost/api/push/send", { headers: { "x-api-key": "test-key" } }));
    expect(pushAlertNotification).not.toHaveBeenCalled();
  });

  it("rejects an overlapping cycle before it can double-alert", async () => {
    vi.resetModules();
    let releaseFetch!: (value: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => { releaseFetch = resolve; })));
    const { GET } = await import("../route");
    const req = new Request("http://localhost/api/push/send", { headers: { "x-api-key": "test-key" } });
    const first = GET(req);
    await Promise.resolve();
    const overlapping = await GET(req);
    expect(await overlapping.json()).toEqual({ skipped: "cycle in flight" });

    releaseFetch({ ok: true, json: async () => [{ sgv: 0, date: Date.now() - 21 * 60_000 }] });
    await first;
    expect(pushAlertNotification).toHaveBeenCalledTimes(1);
  });
});
