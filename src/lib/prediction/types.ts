// ClearSugar — Prediction system types

export interface PredictionPoint {
  timestamp: number; // epoch ms
  sgv: number; // predicted mg/dL
  confidence: {
    low: number; // 10th percentile bound
    high: number; // 90th percentile bound
  };
}

export interface PredictionResult {
  model: PredictionModel;
  horizon: PredictionHorizon;
  points: PredictionPoint[]; // one per 5 min up to horizon
  generatedAt: number; // epoch ms
  staleness: number; // ms since last CGM reading used
  iob: number; // current IOB in units
  cob: number; // current COB in grams
  alerts: PredictiveAlert[];
}

export type PredictionModel = "physiological" | "ml" | "ensemble";
export type PredictionHorizon = 15 | 30 | 60 | 180;

export interface PredictiveAlert {
  type: "low" | "high";
  predictedSgv: number;
  minutesUntil: number; // minutes from now until threshold crossed
  severity: "warning" | "urgent";
}

export interface PredictionSettings {
  activeModel: PredictionModel;
  horizon: PredictionHorizon;
  showOnChart: boolean;
  showOnHero: boolean;
  notifications: NotificationSettings;
}

export interface NotificationSettings {
  enabled: boolean;
  predictedHighThreshold: number; // mg/dL, default 200
  predictedLowThreshold: number; // mg/dL, default 80
  minutesAhead: number; // alert if predicted to cross within N min
  soundEnabled: boolean;
}

export const DEFAULT_PREDICTION_SETTINGS: PredictionSettings = {
  activeModel: "ensemble",
  horizon: 60,
  showOnChart: true,
  showOnHero: true,
  notifications: {
    enabled: false,
    predictedHighThreshold: 200,
    predictedLowThreshold: 80,
    minutesAhead: 30,
    soundEnabled: false,
  },
};

// ML feature vector — 20 canonical features for the LightGBM model.
// The 3 rescue fields below are computed for other consumers but are NOT
// part of the trained model's input (see ML_FEATURE_NAMES, the source of truth).
export interface MLFeatureVector {
  // Current state (4)
  currentSgv: number;
  roc5: number; // rate of change, last 5 min (mg/dL/min)
  roc15: number; // rate of change, last 15 min
  roc30: number; // rate of change, last 30 min

  // Active insulin/carbs (3)
  iob: number; // insulin on board (units)
  cob: number; // carbs on board (grams)
  insulinAge: number; // minutes since last bolus

  // Temporal (4) — cyclical encoding so 23:55 ≈ 00:05
  minuteOfDay: number; // 0-1439
  dayOfWeek: number; // 0-6
  sinTime: number; // sin(2π × minuteOfDay / 1440)
  cosTime: number; // cos(2π × minuteOfDay / 1440)

  // Patient-specific context (5)
  siteAgeHours: number; // hours since last infusion set change
  currentISF: number; // ISF for this time period
  recentCV: number; // coefficient of variation, last 2h
  agpDeviation: number; // current SGV minus AGP median for this slot
  glucoseMomentum: number; // 2nd derivative (mg/dL/min²)

  // Recent history summary (4)
  mean1h: number;
  mean3h: number;
  min1h: number;
  max1h: number;

  // Control-IQ mode (2) — from Sleep/Exercise usermode treatments (v3.0.0 sync)
  sleepActive: number; // 1 if the pump is in a Sleep-mode window, else 0
  exerciseActive: number; // 1 if the pump is in an Exercise-mode window, else 0

  // Inferred rescue carbs (3) — unlogged fast-sugar corrections
  inferredRescueCOB: number; // estimated fast-carb COB from rescue detection (grams)
  rescueCarbActive: number; // 1 if rescue carb is currently absorbing, 0 otherwise
  minutesSinceLastMeal: number; // minutes since last logged carb treatment (capped at 360)
}

// Ordered feature names — must match training script column order (20 features)
export const ML_FEATURE_NAMES: (keyof MLFeatureVector)[] = [
  "currentSgv",
  "roc5",
  "roc15",
  "roc30",
  "iob",
  "cob",
  "insulinAge",
  "minuteOfDay",
  "dayOfWeek",
  "sinTime",
  "cosTime",
  "siteAgeHours",
  "currentISF",
  "recentCV",
  "agpDeviation",
  "glucoseMomentum",
  "mean1h",
  "mean3h",
  "min1h",
  "max1h",
  "sleepActive",
  "exerciseActive",
];

// Rescue-carb features are computed by feature-engine for other uses but are
// intentionally excluded from the trained model (low value / hindsight per the
// 2026-06-12 ML review). Do NOT add these to ML_FEATURE_NAMES without retraining
// AND updating train-model.py FEATURE_NAMES to match in the same order.
export const ML_FEATURE_NAMES_EXTENDED: (keyof MLFeatureVector)[] = [
  "inferredRescueCOB",
  "rescueCarbActive",
  "minutesSinceLastMeal",
];

export interface ModelMetadata {
  trainedAt: string; // ISO date
  trainingDays: number; // how many days of data used
  validationRMSE: Record<PredictionHorizon, number>;
  validationMAE: Record<PredictionHorizon, number>;
  featureImportance: Record<string, number>; // top features
}
