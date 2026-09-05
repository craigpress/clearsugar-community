# Alerting

How ClearSugar decides to interrupt you, and how it decides not to.

An alerting system that cries wolf gets ignored, and an alerting system that is
ignored is worse than none at all — you have the interruptions *and* no safety
net. Most of the design below exists to keep the false-alarm rate low enough
that the alerts stay credible.

## The three emitters

An alert can originate from three places. Knowing which one fired is the first
diagnostic question.

| # | Emitter | Cadence | Cooldown store | Snooze-aware? |
|---|---------|---------|----------------|---------------|
| 1 | Server `/api/push/send` → APNs | timer, alerts on new readings | `push/glucose-alert-state.json` (per-category) | yes |
| 2 | Server `/api/advisor/check` → APNs | 5 min timer | `advisor/last-fired.json` (2h per id) | yes |
| 3 | iOS local backstop (`AlertManager`) | on each fetched reading | UserDefaults (persisted) | yes |

Emitter 3 fires **only** when no server push has been received for ≥15 min. It
is a backstop for the pipeline being down, not a second alerter.

Your CGM's own app and receiver alarms sit outside all of this and are not
gated by anything ClearSugar does. That is deliberate, and it is what makes it
safe for the layers above to be conservative about interrupting you.

## 1. Threshold alerts

Per-device thresholds (`urgentLow` / `low` / `high` / `urgentHigh`), classified
in `src/lib/alert-classify.ts` and paced by `src/lib/alert-policy.ts` (pure and
unit-tested).

- **Per-category cooldowns** — urgentLow 5 min · low 15 min · high 30 min ·
  urgentHigh 15 min. Each category keeps its own clock. A single shared
  `lastAlertType` record is the classic mistake here: two phones with different
  thresholds classify the same reading differently (one phone's `urgentHigh` is
  another's `high`), so they overwrite each other's clock every cycle and
  alerts fire on every timer tick all night.
- **Classification always runs, even while snoozed.** Snooze suppresses the
  push, not the evaluation. Skipping the loop while snoozed leaves "is anyone
  out of range" false, which makes the back-in-range branch below wipe an
  until-range snooze one cycle after it was set — while glucose is still high.
  This is why a snooze can appear to do nothing at all.
- **Sustained in-range clearing** — cooldowns, until-range snoozes and acks
  clear only after 15 min continuously in range
  (`ALERT_SUSTAINED_IN_RANGE_MS`). A single in-range reading only starts the
  clock; clearing instantly means glucose hovering at a threshold re-alerts on
  every crossing.
- **`apns-collapse-id: glucose-<type>`** — a repeat replaces the banner instead
  of stacking. Without it a sustained high leaves a pile of identical banners.
- **Dead-token pruning** — tokens APNs rejects (`BadDeviceToken`,
  `Unregistered`, `ExpiredToken`) are removed from the registration map, the
  per-device preferences and the high-alert recipient list. Logging and
  ignoring them lets stale endpoints accumulate until every alert fans out to
  phones that no longer exist.

## 2. Silencing

| Action | Scope | State |
|--------|-------|-------|
| **Snooze** (30/60/until-range) | ALL devices, chosen categories | `push/snooze-state.json` |
| **Acknowledge** | THIS device, THIS alert type, for that type's cooldown | `push/alert-acks.json` via `POST /api/alerts/ack` |
| Swipe-dismiss | nothing (iOS reports nothing reliable) | — |

An ack deliberately cannot silence another caregiver's phone or mask
escalation: a more urgent category is a different key and still fires
everywhere.

iOS mirrors snoozes locally *before* the POST — offline is exactly when the
backstop runs — and pulls the shared snooze on every foreground, so a snooze
set on one phone or on the website silences every phone's backstop too.

### Advisory snooze coverage

Advisories are keyed on root cause and snoozes on glucose category, so the two
are bridged by `advisorSilencedBySnooze` in `src/lib/alert-policy.ts`:

| advisory | covered by |
|---|---|
| `impending_low` / `rebound_low`, moderate | `all`, `low` |
| `impending_low` / `rebound_low`, **urgent** | `all`, `urgentLow` |
| `ciq_capped_high`, moderate | `all`, `high` |
| `ciq_capped_high`, high/urgent | `all`, `urgentHigh` |
| `failing_site`, `sensor_quality`, `stale_data`, `ketone_risk` | `all` only |

Severity escalates the key, so snoozing `low` never masks a severe impending
low. Snooze suppresses the push only — the advisory is still evaluated, still
recorded for outcome harvesting, and still starts its cooldown.

## 3. Device identity

Tokens are registered by `POST /api/push/register-alert`. When the app sends an
`installId`, the token is keyed to that install: re-registering with a new
token (APNs rotation, device restore) **replaces** the install's previous token
across the registration map, the per-device preferences (thresholds and role
survive the rotation) and its high-alert recipient slot.

Without it, registration is append-only. Tokens pile up, every alert fans out
to every stale endpoint, and a phone holding two live tokens receives each
alert twice.

## 4. The advisor, and why it is quiet

The advisor (`src/lib/prediction/`) is a **residual** layer on top of the pump's
own closed loop: it speaks only to the gap the loop cannot close, and it never
doses. The low advisory (`loop-gap-trigger.ts`) fires only when *all* hold:

0. BG is not already below the threshold.
0b. BG is at or below `MAX_TRIGGER_BG` (90).
1. The rate-of-change projection crosses below the threshold within 30 min.
2. Even an optimistic Control-IQ rollout (basal fully suspended) still ends low.
3. The reading is not a compression-low or sensor-warmup artifact.
3b. The insulin already delivered would, on its own, reach 55 within 30 min.

Gates 0, 0b and 3b were added after measuring the trigger against 284 days of
real data (78,014 anchors, 703 low episodes, 180 of them severe):

| | before | after | |
|---|---|---|---|
| pushes/day | 3.25 | 1.41 | −57% |
| false pushes/day | 1.56 | 0.51 | −67% |
| night wakes/night | 0.636 | 0.158 | −75% |
| **false night wakes/night** | **0.334** | **0.081** | **−76%** |
| low episodes warned early | 29.4% | 30.7% | +1.3 pp |
| severe episodes warned early | 28.3% | 25.6% | −2.7 pp |
| median lead time | 8 min | 10 min | +2 min |

The largest single win was gate 0. Below the threshold, both gate 1 and gate 2
pass unconditionally (the projections are seeded from the current reading), so
the trigger had no specificity mechanism at all in the region where it is most
redundant — 54% of all fires were there, every one with zero lead time, on
glucose that had already tripped every other alarm.

Gate 3b uses the IOB-only hypo floor in `hypo-risk.ts`. That curve is far too
alarmist to alert on directly — it excludes carbs by design, so every meal
bolus makes it project a crash, and it dips below 70 on 27% of all readings —
but as a *second opinion* it is exactly the right shape: it can only ever
remove an alert, and what it removes are rate-of-change excursions with no
insulin behind them.

Reproduce any of this with the harnesses in `scripts/`:

```bash
npx vitest run --config scripts/backtest.vitest.config.ts scripts/advisor-levers.backtest.ts
```

They need `tmp/bt/{entries,treatments,profile}.json` pulled from your own
Nightscout — see the header of `scripts/hypo-risk.backtest.ts` for the exact
queries, including the `find[date]` filter you must pass (`count` alone
silently truncates to a few days).

## 5. Tuning it for yourself

These numbers are one person's data and one family's tolerance for being woken
up. The constants worth revisiting are `MAX_TRIGGER_BG` and `FLOOR_CONFIRM_BG`
in `src/lib/prediction/loop-gap-trigger.ts`, the per-category cooldowns in
`src/lib/alert-classify.ts`, and `ALERT_SUSTAINED_IN_RANGE_MS`.

Pull your own archive and run the sweep before changing them. The metric that
matters is **false wakes per night at fixed severe-episode catch** — not raw
sensitivity, and not point-level precision, which counts every 5-minute reading
inside one sustained warning again and describes nothing a human experiences.
