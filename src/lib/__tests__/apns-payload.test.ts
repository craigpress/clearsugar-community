import { describe, it, expect } from "vitest";
import { buildLiveActivityPayload } from "../apns-payload";

const state = { sgv: 120, trendArrow: "→" };

describe("buildLiveActivityPayload", () => {
  it("builds an update payload without attributes", () => {
    const p = JSON.parse(buildLiveActivityPayload({ event: "update", contentState: state, staleDate: 1000 }));
    expect(p.aps.event).toBe("update");
    expect(p.aps["content-state"]).toEqual(state);
    expect(p.aps["stale-date"]).toBe(1000);
    expect(p.aps["attributes-type"]).toBeUndefined();
    expect(p.aps.attributes).toBeUndefined();
    expect(typeof p.aps.timestamp).toBe("number");
  });

  it("builds a start payload with attributes-type and attributes", () => {
    const p = JSON.parse(buildLiveActivityPayload({
      event: "start", contentState: state, staleDate: 1000,
      attributesType: "GlucoseActivityAttributes", attributes: {},
    }));
    expect(p.aps.event).toBe("start");
    expect(p.aps["attributes-type"]).toBe("GlucoseActivityAttributes");
    expect(p.aps.attributes).toEqual({});
    expect(p.aps["content-state"]).toEqual(state);
  });
});
