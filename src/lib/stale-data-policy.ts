export interface StaleAlertInput {
  dataAgeMs: number;
  staleThresholdMs: number;
  lastStaleAlertAt: number;
  now: number;
  cooldownMs: number;
  isSnoozed: boolean;
}

export function decideStaleAlert(input: StaleAlertInput): boolean {
  return input.dataAgeMs > input.staleThresholdMs
    && !input.isSnoozed
    && (input.lastStaleAlertAt === 0 || input.now - input.lastStaleAlertAt >= input.cooldownMs);
}
