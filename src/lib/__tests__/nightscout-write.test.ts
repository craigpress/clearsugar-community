import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Nightscout treatment writes", () => {
  it("posts a treatment with stable provenance and subject-token auth", async () => {
    vi.stubEnv("NIGHTSCOUT_URL", "https://nightscout.example");
    vi.stubEnv("NIGHTSCOUT_TOKEN", "careportal-token");
    vi.stubEnv("NIGHTSCOUT_API_SECRET", "");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([{
      _id: "0123456789abcdef01234567", mills: 1, created_at: "2026-09-04T12:00:00.000Z",
      eventType: "Carb Correction", enteredBy: "ClearSugar", carbs: 15, insulin: 0,
    }]), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { postTreatment } = await import("../nightscout");
    const result = await postTreatment({ eventType: "Carb Correction", carbs: 15, insulin: 0 });
    expect(result._id).toBe("0123456789abcdef01234567");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("token=careportal-token");
    expect(JSON.parse(init.body)[0]).toMatchObject({ enteredBy: "ClearSugar", carbs: 15 });
  });

  it("rejects an invalid delete id before any network call", async () => {
    vi.stubEnv("NIGHTSCOUT_URL", "https://nightscout.example");
    vi.stubEnv("NIGHTSCOUT_TOKEN", "careportal-token");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { deleteTreatment } = await import("../nightscout");
    await expect(deleteTreatment("not-an-object-id")).rejects.toThrow("invalid id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects writes in demo mode without a network call", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("NIGHTSCOUT_URL", "https://nightscout.example");
    vi.stubEnv("NIGHTSCOUT_TOKEN", "careportal-token");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { postTreatment } = await import("../nightscout");
    await expect(postTreatment({ eventType: "Carb Correction", carbs: 15 })).rejects.toThrow("demo mode");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when no write credential is configured", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("NIGHTSCOUT_URL", "https://nightscout.example");
    vi.stubEnv("NIGHTSCOUT_TOKEN", "");
    vi.stubEnv("NIGHTSCOUT_API_SECRET", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { postTreatment } = await import("../nightscout");
    await expect(postTreatment({ eventType: "Carb Correction", carbs: 15 })).rejects.toThrow("credential not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
