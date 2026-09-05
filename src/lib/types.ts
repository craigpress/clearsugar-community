// ClearSugar — Core data types
// These match Nightscout's API response shapes

export type TrendDirection =
  | "DoubleUp"
  | "SingleUp"
  | "FortyFiveUp"
  | "Flat"
  | "FortyFiveDown"
  | "SingleDown"
  | "DoubleDown"
  | "NOT COMPUTABLE"
  | "RATE OUT OF RANGE"
  | "None";

export interface GlucoseReading {
  _id: string;
  sgv: number; // mg/dL
  date: number; // epoch ms
  dateString: string;
  direction: TrendDirection;
  trend: number; // 1-9 numeric trend
  device: string;
  type: "sgv";
  mills: number;
  delta?: number | null; // mg/dL change from previous reading
}

export interface Treatment {
  _id: string;
  eventType: string;
  created_at: string;
  enteredBy: string;
  mills: number;
  utcOffset: number;
  // Bolus fields
  insulin?: number | null;
  // Carb fields
  carbs?: number | null;
  absorptionTime?: number | null;
  // Temp basal fields
  rate?: number;
  absolute?: number;
  duration?: number;
  reason?: string;
  // Pump event fields
  pump_event_id?: string;
  notes?: string;
  glucose?: number | null; // BG reading from pump screen at time of bolus (tconnectsync)
}

export interface PumpProfile {
  _id: string;
  defaultProfile: string;
  /** When this profile became active — Nightscout keeps one doc per change. */
  startDate?: string;
  created_at?: string;
  store: Record<
    string,
    {
      dia: number | string;
      carbratio: { time: string; value: number; timeAsSeconds: number }[];
      sens: { time: string; value: number; timeAsSeconds: number }[];
      basal: { time: string; value: number; timeAsSeconds: number }[];
      target_low: { time: string; value: number; timeAsSeconds: number }[];
      target_high: { time: string; value: number; timeAsSeconds: number }[];
      timezone: string;
      units: string;
    }
  >;
}

export interface NightscoutStatus {
  status: string;
  name: string;
  version: string;
  serverTime: string;
  apiEnabled: boolean;
  settings: {
    units: string;
    timeFormat: number;
    customTitle: string;
    theme: string;
    thresholds: {
      bgHigh: number;
      bgTargetTop: number;
      bgTargetBottom: number;
      bgLow: number;
    };
  };
}

/**
 * Pump state published to Nightscout `devicestatus` by the CT-110
 * `clearsugar-pumpstate` job (decoupled from tconnectsync). Carries the pump's
 * own IOB (for calibration) + the real Control-IQ settings the sync never wrote.
 * All fields optional — a missing/old doc must degrade gracefully to the
 * profile-derived defaults the advisor already uses.
 */
export interface PumpState {
  device: string;
  created_at: string;
  mills: number; // epoch ms of created_at, derived on read
  pump: {
    clock?: string;
    iob?: {
      iob: number; // units, pump-reported
      timestamp: string; // ISO of the event the IOB was read from
      mills: number; // epoch ms of timestamp, derived on read
      eventCode?: number;
    } | null;
  };
  controlIQ: {
    tdd?: number | null; // total daily insulin (U) CIQ uses for its dosing model
    weightLb?: number | null;
    closedLoop?: boolean | null;
    sleepSchedule?: {
      startMin?: number | null; // minutes from local midnight
      endMin?: number | null;
      enabled?: boolean | null;
      activeDays?: string[] | null;
    } | null;
    basalLimitUHr?: number | null;
    maxBolusU?: number | null;
    profileTargetMgdl?: number | null;
    serialNumber?: string | null;
    softwareVersion?: string | null;
  };
}

// Computed types for the dashboard

export interface GlucoseStats {
  count: number;
  mean: number;
  median: number;
  stddev: number;
  min: number;
  max: number;
  gmi: number; // Glucose Management Indicator (estimated A1c)
  cv: number; // Coefficient of Variation
  timeInRange: {
    veryLow: number; // <54 (%)
    low: number; // 54-70 (%)
    inRange: number; // 70-180 (%)
    high: number; // 180-250 (%)
    veryHigh: number; // >250 (%)
  };
}

export interface DataFreshness {
  lastUpdate: string;
  staleMinutes: number;
  isStale: boolean;
}

// Trend arrow display helpers
export const TREND_ARROWS: Record<TrendDirection, string> = {
  DoubleUp: "⇈",
  SingleUp: "↑",
  FortyFiveUp: "↗",
  Flat: "→",
  FortyFiveDown: "↘",
  SingleDown: "↓",
  DoubleDown: "⇊",
  "NOT COMPUTABLE": "·",
  "RATE OUT OF RANGE": "⚠",
  None: "·",
};

export const TREND_LABELS: Record<TrendDirection, string> = {
  DoubleUp: "Rising fast",
  SingleUp: "Rising",
  FortyFiveUp: "Rising slowly",
  Flat: "Steady",
  FortyFiveDown: "Falling slowly",
  SingleDown: "Falling",
  DoubleDown: "Falling fast",
  "NOT COMPUTABLE": "calculating",
  "RATE OUT OF RANGE": "Out of range",
  None: "waiting",
};

// Glucose range thresholds (mg/dL)
export const GLUCOSE_RANGES = {
  URGENT_LOW: 54,
  LOW: 70,
  TARGET_LOW: 70,
  TARGET_HIGH: 180,
  HIGH: 250,
  URGENT_HIGH: 300,
} as const;
