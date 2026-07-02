#!/usr/bin/env python3
"""
cs_treatments.py — Robust bolus / treatment classifier (Phase 0 task #6).

PROBLEM: ClearSugar's production detector (src/lib/insights/site-sensor-detection.ts)
keys Control-IQ auto-corrections on the BRITTLE exact match
    eventType === "Combo Bolus" && notes === "Automatic Bolus"
and manual corrections on
    eventType === "Combo Bolus" && notes.includes("Override")   // "Standard Bolus (Override)"
The P0.1 replay found this likely UNDERCOUNTS auto-boluses (88 auto vs 1154
manual over 90 days), which is physiologically implausible for Control-IQ.

This module:
  1. CENSUSES the real label space — prints every distinct
     (eventType, normalized-notes) combo with counts + sample insulin/carbs/
     glucose, so we KNOW the labels in the patient's tconnectsync stream
     (measured, not guessed).
  2. Provides classify_bolus(treatment) using normalized/substring matching
     that FAILS SAFE to "unknown" on ambiguity.
  3. Provides Control-IQ temp-basal and site/sensor helpers.
  4. Reports robust vs brittle auto-bolus counts to quantify the undercount.

Pure stdlib (urllib) — reuses the fetch pattern from cs_physio /
phase0_observability. Python 3.13 / Windows; no zoneinfo/tzdata.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict

from cs_physio import (
    NIGHTSCOUT_URL,
    fetch_treatments,
    treatment_time,
)


# ──────────────────────────────────────────────────────────────────────────
# Normalization
# ──────────────────────────────────────────────────────────────────────────
def normalize_notes(notes) -> str:
    """Lowercase, collapse whitespace. Empty string for missing notes."""
    if not notes:
        return ""
    return " ".join(str(notes).split()).lower()


# ──────────────────────────────────────────────────────────────────────────
# Robust classifier
# ──────────────────────────────────────────────────────────────────────────
def classify_bolus(t) -> dict:
    """Classify a treatment that delivered (or could deliver) insulin.

    Returns {'kind': 'auto'|'manual_correction'|'meal'|'unknown', ...}.

    kind semantics:
      auto              — Control-IQ automatic correction bolus (no user input)
      manual_correction — user-initiated correction / override bolus, no carbs
      meal              — bolus accompanied by logged carbs (meal/snack)
      unknown           — has insulin but the label is ambiguous; downstream
                          should SUPPRESS insulin advice on these.

    FAIL-SAFE: anything carrying insulin that we cannot confidently bucket
    returns "unknown" rather than being silently dropped or mislabeled.
    Treatments with no insulin and no carbs return kind 'unknown' with
    has_insulin False so callers can skip them.

    Matching uses normalized substrings, NOT exact equality, so variants like
    "Standard Bolus (Override)", "Automatic Bolus", "Auto Correction" etc. are
    caught even if tconnectsync tweaks the wording.
    """
    et = (t.get("eventType") or "").strip()
    et_l = et.lower()
    notes = normalize_notes(t.get("notes"))
    reason = normalize_notes(t.get("reason"))
    ins = t.get("insulin")
    carbs = t.get("carbs")
    has_insulin = bool(ins and ins > 0)
    has_carbs = bool(carbs and carbs > 0)

    base = {
        "kind": "unknown",
        "eventType": et,
        "notes": t.get("notes"),
        "insulin": ins,
        "carbs": carbs,
        "glucose": t.get("glucose"),
        "mills": treatment_time(t),
        "has_insulin": has_insulin,
        "has_carbs": has_carbs,
    }

    # Pure carb entry (no insulin) — a meal/carb log, not a bolus.
    if has_carbs and not has_insulin:
        base["kind"] = "meal"
        return base

    if not has_insulin:
        # Nothing to classify as a bolus (temp basal, site change, note, etc.)
        return base

    text = f"{notes} {reason}"

    # AUTO: Control-IQ automatic correction. tconnectsync labels these
    # "Automatic Bolus"; guard a few plausible variants via substring.
    auto_markers = ("automatic", "auto correction", "auto-correction", "auto bolus")
    is_auto = any(m in text for m in auto_markers)

    # MANUAL CORRECTION: user override / standard correction bolus with no carbs.
    override_markers = ("override", "correction")

    if is_auto:
        base["kind"] = "auto"
        return base

    if has_carbs:
        # Insulin + carbs = a meal bolus regardless of wording.
        base["kind"] = "meal"
        return base

    if any(m in text for m in override_markers):
        base["kind"] = "manual_correction"
        return base

    # A plain bolus with insulin, no carbs, no auto/override marker. This is a
    # manual correction in practice (user dosed insulin against a high with no
    # food), but wording is absent — classify conservatively as
    # manual_correction ONLY when the eventType is an explicit bolus type;
    # otherwise fail safe to unknown.
    bolus_event_markers = ("bolus",)
    if any(m in et_l for m in bolus_event_markers):
        base["kind"] = "manual_correction"
        return base

    return base  # unknown — fail safe


def classify_auto_brittle(t) -> bool:
    """The EXACT brittle production rule for auto-bolus (for comparison):
    eventType === 'Combo Bolus' && notes === 'Automatic Bolus'."""
    return t.get("eventType") == "Combo Bolus" and t.get("notes") == "Automatic Bolus"


def classify_manual_brittle(t) -> bool:
    """Brittle production rule for manual correction:
    eventType === 'Combo Bolus' && notes.includes('Override')."""
    return (
        t.get("eventType") == "Combo Bolus"
        and bool(t.get("notes"))
        and "Override" in t.get("notes")
    )


# ──────────────────────────────────────────────────────────────────────────
# Control-IQ temp basals / site / sensor helpers
# ──────────────────────────────────────────────────────────────────────────
def control_iq_temp_basals(treatments) -> list:
    """All Control-IQ temp basals: eventType 'Temp Basal', reason 'Algorithm'.
    Returns the raw treatment dicts (with a parsed 'mills')."""
    out = []
    for t in treatments:
        if t.get("eventType") == "Temp Basal" and t.get("reason") == "Algorithm":
            out.append(t)
    return out


def all_temp_basals(treatments) -> list:
    """Every Temp Basal regardless of reason (for completeness)."""
    return [t for t in treatments if t.get("eventType") == "Temp Basal"]


def site_changes(treatments) -> list:
    """Infusion-set / site changes: eventType 'Site Change'."""
    return [t for t in treatments if t.get("eventType") == "Site Change"]


def sensor_starts(treatments) -> list:
    """CGM sensor starts: eventType 'Sensor Start' (any reason; production
    keys on reason 'CGM Session Joined' but we return all and tag the match)."""
    out = []
    for t in treatments:
        if t.get("eventType") == "Sensor Start":
            out.append(t)
    return out


# ──────────────────────────────────────────────────────────────────────────
# Census
# ──────────────────────────────────────────────────────────────────────────
def census(treatments) -> list:
    """Build the full census of distinct (eventType, normalized-notes) combos
    with counts and a representative sample of insulin/carbs/glucose values.

    Returns a list of rows (dicts) sorted by count desc. Also prints a table.
    """
    groups = defaultdict(lambda: {
        "count": 0,
        "reasons": Counter(),
        "ins": [],
        "carbs": [],
        "glucose": [],
    })
    for t in treatments:
        et = (t.get("eventType") or "").strip()
        notes = normalize_notes(t.get("notes"))
        g = groups[(et, notes)]
        g["count"] += 1
        g["reasons"][normalize_notes(t.get("reason"))] += 1
        if t.get("insulin") is not None:
            g["ins"].append(t.get("insulin"))
        if t.get("carbs") is not None:
            g["carbs"].append(t.get("carbs"))
        if t.get("glucose") is not None:
            g["glucose"].append(t.get("glucose"))

    rows = []
    for (et, notes), g in groups.items():
        def samp(vals):
            v = [x for x in vals if x is not None]
            if not v:
                return ""
            uniq = sorted(set(v))[:5]
            return ",".join(str(x) for x in uniq)
        top_reason = g["reasons"].most_common(1)[0][0] if g["reasons"] else ""
        rows.append({
            "eventType": et,
            "notes": notes,
            "count": g["count"],
            "top_reason": top_reason,
            "insulin_samples": samp(g["ins"]),
            "carbs_samples": samp(g["carbs"]),
            "glucose_samples": samp(g["glucose"]),
        })
    rows.sort(key=lambda r: r["count"], reverse=True)
    return rows


def print_census(rows):
    print("\n=== TREATMENT CENSUS: distinct (eventType, normalized-notes) ===")
    hdr = f"{'count':>6}  {'eventType':<22} {'notes (normalized)':<28} {'reason':<16} {'ins':<14} {'carbs':<10} {'glucose'}"
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        print(
            f"{r['count']:>6}  {r['eventType'][:22]:<22} {r['notes'][:28]:<28} "
            f"{r['top_reason'][:16]:<16} {r['insulin_samples'][:14]:<14} "
            f"{r['carbs_samples'][:10]:<10} {r['glucose_samples']}"
        )


def report(treatments):
    """Run the full Phase 0 #6 report against a list of treatments."""
    rows = census(treatments)
    print_census(rows)

    # Robust classification tallies
    kinds = Counter()
    robust_auto = []
    for t in treatments:
        c = classify_bolus(t)
        kinds[c["kind"]] += 1
        if c["kind"] == "auto":
            robust_auto.append(t)

    brittle_auto = [t for t in treatments if classify_auto_brittle(t)]
    brittle_manual = [t for t in treatments if classify_manual_brittle(t)]
    robust_manual = sum(1 for t in treatments if classify_bolus(t)["kind"] == "manual_correction")

    print("\n=== ROBUST classifier tallies ===")
    for k in ("auto", "manual_correction", "meal", "unknown"):
        print(f"  {k:<18} {kinds.get(k, 0)}")

    print("\n=== BRITTLE vs ROBUST auto-bolus undercount ===")
    print(f"  brittle auto (exact 'Automatic Bolus'):   {len(brittle_auto)}")
    print(f"  robust  auto (substring/normalized):      {len(robust_auto)}")
    delta = len(robust_auto) - len(brittle_auto)
    print(f"  undercount by brittle rule:               {delta}")
    print(f"  brittle manual ('Override'):              {len(brittle_manual)}")
    print(f"  robust  manual_correction:                {robust_manual}")

    print("\n=== Control-IQ / device helpers ===")
    print(f"  Control-IQ temp basals (Algorithm): {len(control_iq_temp_basals(treatments))}")
    print(f"  all temp basals:                    {len(all_temp_basals(treatments))}")
    print(f"  site changes:                       {len(site_changes(treatments))}")
    print(f"  sensor starts:                      {len(sensor_starts(treatments))}")

    return {
        "census": rows,
        "kinds": dict(kinds),
        "brittle_auto": len(brittle_auto),
        "robust_auto": len(robust_auto),
        "undercount": delta,
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=NIGHTSCOUT_URL)
    ap.add_argument("--days", type=int, default=90)
    args = ap.parse_args()
    treats = fetch_treatments(args.url, args.days)
    print(f"Fetched {len(treats)} treatments over {args.days} days from {args.url}")
    report(treats)
