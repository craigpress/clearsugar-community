import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "cs-la-")); process.env.CLEARSUGAR_DATA_DIR = dir; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("live-activity-store", () => {
  // `now` is passed explicitly wherever an update token is written: setting one
  // stamps `activitySince` (the liveness clock decideStart reads), so an implicit
  // Date.now() would make these assertions non-deterministic.
  const T0 = 1_700_000_000_000;

  it("upserts an update token under an installId", async () => {
    const { loadInstalls, upsertToken, saveInstalls } = await import("../live-activity-store");
    const s = await loadInstalls();
    upsertToken(s, { installId: "inst-1", device: "Example", kind: "update", token: "utok", now: T0 });
    await saveInstalls(s);
    const reloaded = await loadInstalls();
    expect(reloaded["inst-1"]).toEqual({ device: "Example", updateToken: "utok", activitySince: T0 });
  });

  it("keeps start and update tokens on the same install", async () => {
    const { loadInstalls, upsertToken } = await import("../live-activity-store");
    const s = await loadInstalls();
    upsertToken(s, { installId: "i", device: "d", kind: "update", token: "u", now: T0 });
    upsertToken(s, { installId: "i", device: "d", kind: "start", token: "st" });
    expect(s["i"]).toEqual({ device: "d", updateToken: "u", startToken: "st", activitySince: T0 });
  });

  // ── liveness clock + end-ack (the 2026-07-21 overnight failure) ──────────────

  it("restamps activitySince only when the update token actually changes", async () => {
    const { loadInstalls, upsertToken } = await import("../live-activity-store");
    const s = await loadInstalls();
    upsertToken(s, { installId: "i", device: "d", kind: "update", token: "u1", now: T0 });
    // Same token re-registered — same activity, so the clock must NOT restart,
    // otherwise a long-lived dead activity keeps renewing its own liveness window.
    upsertToken(s, { installId: "i", device: "d", kind: "update", token: "u1", now: T0 + 60_000 });
    expect(s["i"].activitySince).toBe(T0);
    // New token = new activity → clock restarts.
    upsertToken(s, { installId: "i", device: "d", kind: "update", token: "u2", now: T0 + 90_000 });
    expect(s["i"].activitySince).toBe(T0 + 90_000);
  });

  it("markActivityEnded records the ack, and a new activity clears it", async () => {
    const { loadInstalls, upsertToken, markActivityEnded } = await import("../live-activity-store");
    const s = await loadInstalls();
    upsertToken(s, { installId: "i", device: "d", kind: "update", token: "u1", now: T0 });
    expect(markActivityEnded(s, "i", T0 + 1000)).toBe(true);
    expect(s["i"].endedAt).toBe(T0 + 1000);
    // The ack described the OLD activity; a new one supersedes it.
    upsertToken(s, { installId: "i", device: "d", kind: "update", token: "u2", now: T0 + 2000 });
    expect(s["i"].endedAt).toBeUndefined();
  });

  it("markActivityEnded reports false for an unknown install (already pruned)", async () => {
    const { loadInstalls, markActivityEnded } = await import("../live-activity-store");
    const s = await loadInstalls();
    expect(markActivityEnded(s, "nope", T0)).toBe(false);
  });

  it("migrates the legacy token->device map on first load", async () => {
    const { saveJSON } = await import("../local-store");
    await saveJSON("push/live-activity-tokens.json", { legacyTokenAAAABBBB: "OldPhone" });
    const { loadInstalls } = await import("../live-activity-store");
    const s = await loadInstalls();
    const entries = Object.values(s);
    expect(entries).toContainEqual({ device: "OldPhone", updateToken: "legacyTokenAAAABBBB" });
  });

  it("synthesizes an installId from the token when none is provided (build-7 compat)", async () => {
    const { loadInstalls, upsertToken } = await import("../live-activity-store");
    const s = await loadInstalls();
    const id = upsertToken(s, { device: "b7", kind: "update", token: "tokXYZ" });
    expect(id).toBe("tok:tokXYZ");
    expect(s["tok:tokXYZ"].updateToken).toBe("tokXYZ");
  });

  it("removeToken drops the token non-destructively, keeping the install for re-registration", async () => {
    const { loadInstalls, upsertToken, removeToken } = await import("../live-activity-store");
    const s = await loadInstalls();
    upsertToken(s, { installId: "i", device: "d", kind: "update", token: "u" });
    removeToken(s, "u", 1000);
    // Record survives (device identity kept), token cleared, marked token-less.
    expect(s["i"]).toBeDefined();
    expect(s["i"].updateToken).toBeUndefined();
    expect(s["i"].device).toBe("d");
    expect(s["i"].tokensLostAt).toBe(1000);
    // Re-registration restores it in place and clears the token-less marker.
    upsertToken(s, { installId: "i", device: "d", kind: "update", token: "u2" });
    expect(s["i"].updateToken).toBe("u2");
    expect(s["i"].tokensLostAt).toBeUndefined();
  });

  it("prunes update and start tokens independently (a dead update token keeps push-to-start)", async () => {
    const { loadInstalls, upsertToken, removeToken } = await import("../live-activity-store");
    const s = await loadInstalls();
    upsertToken(s, { installId: "i", device: "d", kind: "update", token: "u" });
    upsertToken(s, { installId: "i", device: "d", kind: "start", token: "s" });
    removeToken(s, "u", 2000);
    // Start token (resurrection) survives; not token-less, so no marker.
    expect(s["i"].updateToken).toBeUndefined();
    expect(s["i"].startToken).toBe("s");
    expect(s["i"].tokensLostAt).toBeUndefined();
  });

  it("deletes the legacy file after migration so an emptied store doesn't resurrect tokens", async () => {
    const { saveJSON, loadJSON, deleteJSON } = await import("../local-store");
    const { loadInstalls, saveInstalls } = await import("../live-activity-store");
    await deleteJSON("push/live-activities.json"); // ensure empty store so migration runs
    await saveJSON("push/live-activity-tokens.json", { deadTok: "OldPhone" });
    await loadInstalls(); // migrates + deletes legacy
    expect(await loadJSON("push/live-activity-tokens.json", { gone: true })).toEqual({ gone: true });
    // Simulate the store emptying (all tokens pruned) → must NOT resurrect.
    await saveInstalls({});
    expect(await loadInstalls()).toEqual({});
  });
});

// ── Regression: start-attempt bookkeeping (2026-07-22) ──
// The route used to restamp `activitySince` when a push-to-start was *sent*.
// A start attempt is not evidence that an activity exists, so that reset the
// very liveness clock the retry depends on — each failed attempt deferred the
// next one by another full lifetime and the retry never converged. Attempts are
// now tracked separately and only a real update-token registration clears them.
describe("live-activity-store — start attempts", () => {
  const T0 = 1_700_000_000_000;

  it("records a start attempt without touching the liveness clock", async () => {
    const { loadInstalls, upsertToken, recordStartAttempt } = await import("../live-activity-store");
    const s = await loadInstalls();
    upsertToken(s, { installId: "i1", device: "Example", kind: "update", token: "u1", now: T0 });
    expect(s["i1"].activitySince).toBe(T0);

    recordStartAttempt(s, "i1", T0 + 60_000);
    expect(s["i1"].activitySince).toBe(T0);          // unchanged — this is the fix
    expect(s["i1"].lastStartAt).toBe(T0 + 60_000);
    expect(s["i1"].startAttempts).toBe(1);

    recordStartAttempt(s, "i1", T0 + 120_000);
    expect(s["i1"].startAttempts).toBe(2);           // consecutive failures accumulate
    expect(s["i1"].activitySince).toBe(T0);
  });

  it("clears attempt state when a genuinely new update token confirms an activity", async () => {
    const { loadInstalls, upsertToken, recordStartAttempt } = await import("../live-activity-store");
    const s = await loadInstalls();
    upsertToken(s, { installId: "i1", device: "Example", kind: "update", token: "u1", now: T0 });
    recordStartAttempt(s, "i1", T0 + 60_000);
    s["i1"].endedAt = T0 + 30_000;

    upsertToken(s, { installId: "i1", device: "Example", kind: "update", token: "u2", now: T0 + 90_000 });
    expect(s["i1"].startAttempts).toBeUndefined();
    expect(s["i1"].lastStartAt).toBeUndefined();
    expect(s["i1"].endedAt).toBeUndefined();
    expect(s["i1"].activitySince).toBe(T0 + 90_000);
  });

  it("does not clear attempt state when the same update token is re-registered", async () => {
    // A repeat registration of the SAME token is not a new activity, so it must
    // not look like confirmation of a start that never landed.
    const { loadInstalls, upsertToken, recordStartAttempt } = await import("../live-activity-store");
    const s = await loadInstalls();
    upsertToken(s, { installId: "i1", device: "Example", kind: "update", token: "u1", now: T0 });
    recordStartAttempt(s, "i1", T0 + 60_000);

    upsertToken(s, { installId: "i1", device: "Example", kind: "update", token: "u1", now: T0 + 90_000 });
    expect(s["i1"].startAttempts).toBe(1);
    expect(s["i1"].activitySince).toBe(T0);
  });

  it("is a no-op for an unknown install", async () => {
    const { loadInstalls, recordStartAttempt } = await import("../live-activity-store");
    const s = await loadInstalls();
    expect(recordStartAttempt(s, "nope", T0)).toBe(false);
  });
});
