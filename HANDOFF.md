# Community ClearSugar handoff — 2026-09-04

Ported shared fixes from private product review: pump-source freshness and unknown-age suppression; identity-only carb dedup and per-treatment absorption spans; Python training/evaluation spans; atomic storage (including binary operations); supported Next route exports; owner-only device assignment using local roles.

Validated on Windows: 116 tests, tsc, production build. Private counterpart: 676 tests, Python COB parity, 52 iOS tests. Family meal UI/AuthentiK endpoints were not copied.

Actual code differs from private more than old sync notes claimed: no private ack route, older momentum reconciliation and 22-feature schema (no expectedDrop). This patch preserves that schema and limits physiology changes to COB. Prior documentation, package-lock and .20f formatting edits remain uncommitted; do not overwrite them.
