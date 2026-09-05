import { describe, it, expect } from "vitest";
import { replaceAlertToken, removeAlertToken } from "../alert-token-store";

// Regression cover for alert-token churn (2026-07-24): 8 tokens were registered
// for ~3 phones because nothing ever pruned an install's previous token when it
// re-registered (reinstall or APNs rotation), and BadDeviceToken failures on the
// alert path were logged and ignored. Consequences observed live: every alert
// went to 8 endpoints, and both high-alert recipients were long-dead tokens.

const mk = () => ({
  tokens: { old1: "iPhone", other: "iPhone" } as Record<string, string>,
  prefs: {
    old1: { device: "iPhone", owner: "Parent", role: "parent", thresholdUrgentLow: 55, thresholdLow: 70, thresholdHigh: 200, thresholdUrgentHigh: 260 },
  } as Record<string, unknown>,
  recipients: ["old1", "other"] as string[],
});

describe("replaceAlertToken", () => {
  it("moves registration, prefs, and recipient slot from the old token to the new", () => {
    const s = mk();
    replaceAlertToken(s, "old1", "new1", "iPhone");
    expect(s.tokens).toEqual({ new1: "iPhone", other: "iPhone" });
    expect(s.prefs.new1).toMatchObject({ owner: "Parent", thresholdHigh: 200 });
    expect(s.prefs.old1).toBeUndefined();
    expect(s.recipients).toEqual(["new1", "other"]);
  });

  it("does not clobber prefs the new token already has", () => {
    const s = mk();
    s.prefs.new1 = { device: "iPhone", owner: "Parent", thresholdHigh: 210 };
    replaceAlertToken(s, "old1", "new1", "iPhone");
    expect((s.prefs.new1 as { thresholdHigh: number }).thresholdHigh).toBe(210);
    expect(s.prefs.old1).toBeUndefined();
  });

  it("same token is a no-op", () => {
    const s = mk();
    replaceAlertToken(s, "old1", "old1", "iPhone");
    expect(s.tokens.old1).toBe("iPhone");
    expect(s.recipients).toEqual(["old1", "other"]);
  });

  it("handles an unknown old token (fresh install) by just registering the new one", () => {
    const s = mk();
    replaceAlertToken(s, "never-seen", "new1", "iPhone");
    expect(s.tokens.new1).toBe("iPhone");
    expect(s.tokens["never-seen"]).toBeUndefined();
    expect(s.recipients).toEqual(["old1", "other"]);
  });
});

describe("removeAlertToken", () => {
  it("removes the token from the map and the recipients list (APNs said it is dead)", () => {
    const s = mk();
    const changed = removeAlertToken(s, "old1");
    expect(changed).toBe(true);
    expect(s.tokens).toEqual({ other: "iPhone" });
    expect(s.recipients).toEqual(["other"]);
    // Prefs are deliberately retained: a later re-register with the same
    // installId migrates them to the replacement token.
    expect(s.prefs.old1).toBeDefined();
  });
  it("returns false when the token is unknown", () => {
    const s = mk();
    expect(removeAlertToken(s, "nope")).toBe(false);
  });
});
