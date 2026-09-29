import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const remote = vi.hoisted(() => ({ postTreatment: vi.fn(), deleteTreatment: vi.fn() }));
vi.mock("@/lib/nightscout", () => remote);
vi.mock("@/lib/insights/vision-client", () => ({
  VisionOutputError: class extends Error {},
  VisionUnavailableError: class extends Error {},
  estimateNutrition: vi.fn(async () => ({ estimate: { carbs: { low: 10, mid: 14, high: 20 },
    confidence: 0.5, model: "test", provider: "test", estimatedAt: Date.now(), rawResponse: "{}",
    promptVersion: "meal-nutrition-2026-09-07-v2" }, latencyMs: 1 })),
}));
vi.mock("@/lib/api-auth", () => ({
  requireApiAuth: vi.fn().mockResolvedValue(null),
  getAuthIdentity: (req: Request) => ({ sub: req.headers.get("test-sub") ?? "parent" }),
}));

let dir: string;
let route: typeof import("@/app/api/meals/route");
let undo: typeof import("@/app/api/meals/[id]/route");
let storage: typeof import("@/lib/local-store");
let scope: typeof import("../profile-storage");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "meal-profile-"));
  vi.stubEnv("CLEARSUGAR_DATA_DIR", dir);
  vi.stubEnv("MEAL_VISION_URL", "http://localhost:8080/v1");
  vi.stubEnv("MEAL_VISION_MODEL", "test-only");
  vi.resetModules();
  storage = await import("@/lib/local-store");
  scope = await import("../profile-storage");
  route = await import("@/app/api/meals/route");
  undo = await import("@/app/api/meals/[id]/route");
  await storage.saveJSON("auth/users", { users: [{ username: "parent", role: "parent" }, { username: "patient", role: "child" }, { username: "owner", role: "owner" }, { username: "viewer", role: "viewer" }] });
  await storage.saveJSON("profile/meals", [{ id: "patient", name: "Primary", isTest: false, members: ["parent", "patient"] }, { id: "sandbox", name: "Sandbox", isTest: true, members: ["parent"] }]);
});
afterAll(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

const request = (child: string | null, body?: unknown, sub = "parent") => new Request("https://cs.test/api/meals", {
  method: body ? "POST" : "GET",
  headers: { "test-sub": sub, ...(child !== null && { "X-Meal-Child": child }) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const input = () => ({ clientId: crypto.randomUUID(), grams: 42, carbClass: "meal", reason: "other",
  eatenAt: new Date(Date.now() - 67 * 60_000).toISOString(),
  description: "Ribs with BBQ sauce", nutrition: { carbs: { low: 30, mid: 42, high: 60 }, confidence: 0.5,
    notes: "Includes two tablespoons of sauce", followUp: "Did you account for BBQ sauce?" } });

describe("meal profile isolation", () => {
  it("only lets owners configure arbitrary profiles and grants only assigned accounts access", async () => {
    const manage = await import("@/app/api/meals/profiles/route");
    const body = { id: "family-two", name: "Family member", isTest: false, members: ["patient"] };
    expect((await manage.POST(request(null, body, "parent"))).status).toBe(403);
    expect((await manage.POST(request(null, { ...body, id: "../escape" }, "owner"))).status).toBe(400);
    expect((await manage.POST(request(null, { ...body, members: ["missing"] }, "owner"))).status).toBe(400);
    expect((await manage.POST(request(null, body, "owner"))).status).toBe(200);
    expect((await route.GET(request("family-two", undefined, "parent"))).status).toBe(403);
    expect((await route.GET(request("family-two", undefined, "viewer"))).status).toBe(403);
    remote.postTreatment.mockClear();
    const response = await route.POST(request("family-two", input(), "patient"));
    expect(response.status).toBe(201);
    expect((await response.json()).meal).toMatchObject({ childId: "family-two", isTest: false });
    expect(remote.postTreatment).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await manage.POST(request(null, { ...body, members: [] }, "owner"));
    expect((await route.GET(request("family-two", undefined, "patient"))).status).toBe(403);
  });

  it("keeps photos scoped to the selected profile and rejects cross-profile attachment", async () => {
    const photos = await import("../photos");
    const photoRoute = await import("@/app/api/meals/photo/[id]/route");
    const id = crypto.randomUUID();
    await scope.mealScope.run({ id: "sandbox", name: "Sandbox", isTest: true, members: [] },
      () => scope.saveBinary(photos.photoKey(id), Buffer.from("test")));
    expect((await photoRoute.GET(request("sandbox"), { params: Promise.resolve({ id }) })).status).toBe(200);
    expect((await route.POST(request("patient", { ...input(), photoId: id }))).status).toBe(400);
    expect((await photoRoute.GET(request("patient"), { params: Promise.resolve({ id }) })).status).toBe(404);
    expect((await photoRoute.GET(request("sandbox", undefined, "patient"), { params: Promise.resolve({ id }) })).status).toBe(403);
    expect(await photos.loadPhoto("../escape")).toBeNull();
  });

  it("archives each text estimate revision without making a meal or leaking into Patient", async () => {
    const estimateRoute = await import("@/app/api/meals/estimate/route");
    const first = await estimateRoute.POST(request("sandbox", { description: "ribs" }));
    expect(first.status).toBe(200);
    const { estimate } = await first.json();
    const second = await estimateRoute.POST(request("sandbox", { description: "ribs", previousEstimate: estimate,
      followUp: "Did you account for BBQ sauce?" }));
    expect(second.status).toBe(200);
    const revised = (await second.json()).estimate;
    expect(revised.estimateId).not.toBe(estimate.estimateId);
    expect(await storage.listKeys("meal-estimate-revisions/")).toEqual([]);
    expect(await storage.listKeys("meal-profiles/sandbox/meal-estimate-revisions/")).toHaveLength(2);
    expect(await storage.loadJSON(`meal-profiles/sandbox/meal-estimate-revisions/${revised.estimateId}.json`, {}))
      .toMatchObject({ schemaVersion: 1, childId: "sandbox", isTest: true, previousEstimate: estimate,
        followUp: "Did you account for BBQ sauce?", estimate: revised });
    expect((await (await route.GET(request("sandbox"))).json()).meals).toHaveLength(0);
    expect(remote.postTreatment).not.toHaveBeenCalled();
  });
  it("requires an explicit parent destination and rejects unknown/conflicting profiles", async () => {
    expect((await route.POST(request(null, input()))).status).toBe(400);
    expect((await route.POST(request("../patient", input()))).status).toBe(400);
    expect((await route.POST(request("sandbox", { ...input(), childId: "patient" }))).status).toBe(400);
    expect(remote.postTreatment).not.toHaveBeenCalled();
  });
  it("prevents patients and unassigned identities from opening the parent test profile", async () => {
    expect((await route.GET(request("sandbox", undefined, "patient"))).status).toBe(403);
    expect((await route.POST(request("patient", input(), "unknown"))).status).toBe(403);
  });
  it("saves, retries, reads and deletes a test meal without touching real meals or Nightscout", async () => {
    const body = input();
    const created = await route.POST(request("sandbox", body));
    expect(created.status).toBe(201);
    const { meal } = await created.json();
    expect(meal).toMatchObject({ schemaVersion: 1, eatenAtSource: "client_reported", carbGramsSource: "ai_estimate_accepted" });
    expect(meal).toMatchObject({ childId: "sandbox", isTest: true, grams: 42, eatenAt: Date.parse(body.eatenAt), nutrition: body.nutrition });
    const retry = await route.POST(request("sandbox", body));
    expect(retry.status).toBe(200);
    expect((await retry.json()).meal.id).toBe(meal.id);
    expect((await (await route.GET(request("sandbox"))).json()).meals).toHaveLength(1);
    expect((await (await route.GET(request("patient"))).json()).meals).toHaveLength(0);
    expect(await storage.listKeys("meals/")).toEqual([]);
    expect((await undo.DELETE(request("patient"), { params: Promise.resolve({ id: meal.id }) })).status).toBe(404);
    expect((await undo.DELETE(request("sandbox"), { params: Promise.resolve({ id: meal.id }) })).status).toBe(200);
    expect((await (await route.GET(request("sandbox"))).json()).meals).toHaveLength(0);
    expect(remote.postTreatment).not.toHaveBeenCalled();
    expect(remote.deleteTreatment).not.toHaveBeenCalled();
  });
  it("preserves profile context across concurrent awaits, binary photos, episodes and enumeration", async () => {
    await Promise.all(["patient", "sandbox"].map(child => scope.mealScope.run({ id: child, name: child, isTest: child === "sandbox", members: [] }, async () => {
      await scope.saveJSON("meals/episodes/test.json", { child });
      await scope.saveBinary("photos/same.jpg", Buffer.from(child));
      await new Promise(resolve => setTimeout(resolve, child === "patient" ? 8 : 1));
      expect(await scope.loadJSON("meals/episodes/test.json", {})).toEqual({ child });
      expect((await scope.loadBinary("photos/same.jpg"))?.toString()).toBe(child);
      expect(await scope.listKeys("meals/episodes/")).toEqual(["meals/episodes/test.json"]);
    })));
    expect(await storage.loadJSON("meals/episodes/test.json", {})).toEqual({ child: "patient" });
  });
  it("still mirrors a parent entry explicitly selected for Patient", async () => {
    remote.postTreatment.mockImplementation(async doc => ({ _id: doc._id }));
    const body = input();
    const created = await route.POST(request("patient", body));
    expect(created.status).toBe(201);
    const { meal } = await created.json();
    expect(meal.isTest).toBe(false);
    expect(remote.postTreatment).toHaveBeenCalledOnce();
    expect(remote.postTreatment.mock.calls[0][0]).toMatchObject({ carbs: 42, absorptionTime: 180, created_at: body.eatenAt });
  });
});
