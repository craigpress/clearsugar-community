// Single source of truth for the insights/chat model preset shown in the UI
// selector. Imported by both the server LLM client (getAvailableModels) and
// the insights page selector so the two lists cannot drift.
//
// With the pluggable provider layer (see llm-client.ts and ./providers/),
// the actual model is resolved entirely from environment configuration
// (LLM_PROVIDER plus a provider-specific *_MODEL env var) rather than
// selected per request — so this intentionally has a single generic entry
// rather than a list of hardcoded model presets.
export const DEFAULT_INSIGHTS_MODEL = "configured";

export const MODEL_OPTIONS: Array<{ id: string; label: string; provider: string }> = [
  { id: "configured", label: "Configured model (set via LLM_PROVIDER)", provider: "env" },
];
