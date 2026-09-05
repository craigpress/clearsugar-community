#!/usr/bin/env python3
"""Assert COB parity for variable absorption spans and explicit document identity."""
import numpy as np
import pandas as pd
from cs_physio import calc_cob, dedupe_carb_treatments
from cs_features import calculate_cob, _carb_rows, precompute_carb_spans

NOW = 1700000000000

def carb(identity, grams, age=0, span=180):
    return {"_id": identity, "carbs": grams, "mills": NOW - age * 60000,
            "created_at": "", "absorptionTime": span}

def check(rows, expected=None):
    frame = pd.DataFrame(rows)
    kept = _carb_rows(frame)
    spans = precompute_carb_spans(frame)
    feature = calculate_cob(kept["mills"].values.astype(float), kept["carbs"].values.astype(float), NOW, spans)
    physio = calc_cob(rows, NOW)
    assert abs(feature - physio) < 1e-10, (feature, physio)
    assert len(kept) == len(dedupe_carb_treatments(rows))
    if expected is not None:
        assert abs(feature - expected) < 1e-10, (feature, expected)

for span in [30, 180, 360]:
    for age in [0, 8, 20, 30, 60, 120, 180, 240, 300, 420]:
        fraction = min(1, age / span)
        expected = 60 * (1 - fraction * fraction * (3 - 2 * fraction))
        check([carb("one", 60, age, span)], expected)

# The same fixtures/expectations are asserted in carb-absorption.test.ts.
check([carb("pump", 45), carb("manual", 45)], 90)
check([carb("a", 15), carb("b", 20), carb("a", 15)], 35)
check([carb("", 15), carb("", 15)], 30)
check([carb("a", 15, 8, 30), carb("b", 15, 0, 30)], 15 * (1 - (8/30)**2 * (3 - 2*8/30)) + 15)
print("COB PARITY OK: 33 curve cases and 4 identity cases")
