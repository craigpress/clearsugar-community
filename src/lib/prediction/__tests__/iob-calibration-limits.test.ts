import { afterEach, expect, it, vi } from "vitest";
import { compareIob } from "../iob-calibration";
import type { PumpState, PumpProfile } from "../../types";

vi.mock("../physiological-model", () => ({ calculateIOB: () => 2 }));
afterEach(() => vi.unstubAllEnvs());

function sample(value: number) {
  const now = Date.now();
  return compareIob({ pump: { iob: { iob: value, mills: now } } } as PumpState,
    [], {} as PumpProfile, now);
}

it("rejects malformed and negative insulin without a personal ceiling", () => {
  vi.stubEnv("IOB_CALIBRATION_MAX_U", "");
  for (const value of [NaN, Infinity, -1]) expect(sample(value)).toBeNull();
  expect(sample(35)?.pumpIob).toBe(35);
});

it("honors the installation's optional ceiling", () => {
  vi.stubEnv("IOB_CALIBRATION_MAX_U", "20");
  expect(sample(20)?.pumpIob).toBe(20);
  expect(sample(21)).toBeNull();
});
