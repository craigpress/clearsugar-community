import { describe, it, expect } from "vitest";
import { localHour, localDayOfWeek, localDateKey, PATIENT_TZ } from "../time";

describe("time helpers (America/New_York)", () => {
  it("exposes the patient timezone", () => {
    expect(PATIENT_TZ).toBe("America/New_York");
  });

  // 2026-01-15T12:00:00Z — winter, ET is UTC-5 (EST) => 07:00 ET, Thursday
  const winter = Date.UTC(2026, 0, 15, 12, 0, 0);
  // 2026-07-15T12:00:00Z — summer, ET is UTC-4 (EDT) => 08:00 ET, Wednesday
  const summer = Date.UTC(2026, 6, 15, 12, 0, 0);

  it("computes localHour with the correct DST offset", () => {
    expect(localHour(winter)).toBe(7); // EST = UTC-5
    expect(localHour(summer)).toBe(8); // EDT = UTC-4
  });

  it("computes localDayOfWeek in ET", () => {
    // 2026-01-15 is a Thursday => 4
    expect(localDayOfWeek(winter)).toBe(4);
    // 2026-07-15 is a Wednesday => 3
    expect(localDayOfWeek(summer)).toBe(3);
  });

  it("computes localDateKey in ET", () => {
    expect(localDateKey(winter)).toBe("2026-01-15");
    expect(localDateKey(summer)).toBe("2026-07-15");
  });

  it("rolls the date back when ET is the previous day (early UTC hours)", () => {
    // 2026-07-15T02:00:00Z => 2026-07-14 22:00 ET
    const ts = Date.UTC(2026, 6, 15, 2, 0, 0);
    expect(localDateKey(ts)).toBe("2026-07-14");
    expect(localHour(ts)).toBe(22);
  });
});
