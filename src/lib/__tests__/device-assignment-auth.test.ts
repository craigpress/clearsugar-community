import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ requireApiAuth: vi.fn(), getAuthIdentity: vi.fn(), loadJSON: vi.fn(), saveJSON: vi.fn() }));
vi.mock("@/lib/api-auth", () => mocks);
vi.mock("@/lib/local-store", () => mocks);
import { PATCH } from "@/lib/server/alert-preferences";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireApiAuth.mockResolvedValue(null);
  mocks.loadJSON.mockImplementation(async (key: string) => key.includes("preferences") ? { "device-123456": { device: "iPhone", sub: "patient" } } : {});
});
describe("device assignment authorization", () => {
  it.each([null, { sub: "p", role: "child" }, { sub: "p", role: "parent" }, { sub: "p", role: undefined }])("rejects non-owner assignment", async identity => {
    mocks.getAuthIdentity.mockResolvedValue(identity);
    const res = await PATCH(new Request("https://cs.test/api/alerts/preferences", { method: "PATCH", body: JSON.stringify({ tokenSuffix: "123456", role: "patient" }) }));
    expect(res.status).toBe(403);
    expect(mocks.saveJSON).not.toHaveBeenCalled();
  });
  it("allows an explicit owner to persist the identity mapping", async () => {
    mocks.getAuthIdentity.mockResolvedValue({ sub: "owner", role: "owner" });
    const res = await PATCH(new Request("https://cs.test/api/alerts/preferences", { method: "PATCH", body: JSON.stringify({ tokenSuffix: "123456", role: "patient" }) }));
    expect(res.status).toBe(200);
    expect(mocks.saveJSON).toHaveBeenCalledWith("push/identities.json", { patient: { role: "patient" } });
  });
});
