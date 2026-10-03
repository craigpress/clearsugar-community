# Community sync and privacy

The community edition shares prediction, treatment integrity, analysis, and push
delivery logic with the personalized apps. It deliberately uses local credentials
auth, a runtime patient profile, configurable Apple identifiers, synthetic demo data,
and a pluggable AI provider.

The September 2026 refresh includes install-keyed Live Activity registration and
recovery, persisted start retry backoff, ended-activity acknowledgements, direct
prediction calls, server stale-data alerts, and iOS alert backstop/deduplication.
Sensor validity and widget no-data rendering agree across server, iPhone, and Watch.

Private SSO, home automation, deployment topology, clinical records and signing files
are not copied into this edition. Family profiles and meal/photo logging are now
generalized: runtime names, explicit account assignments, isolated local journals,
and an optional user-configured vision provider. See [MEALS.md](MEALS.md).
The analysis/ML timezone remains documented as US Eastern for feature parity.
Quiet hours and the optional calibration ceiling are installation configuration,
not a copied patient schedule or patient-specific insulin limit.

## Before importing changes

1. Review the complete diff, including comments, tests, documentation, and images.
2. Keep secrets in environment variables and local storage, never source or examples.
3. Run `python scripts/check-sanitization.py`, tests, type checking, and the build.
4. Install the staged-file hook with
   `cp scripts/check-sanitization.sh .git/hooks/pre-commit`.
   Put private names/domains in `.git/sanitization-denylist`, never in this repository.
5. Run a secret scanner over Git history as well as the proposed commit. The included
   pattern check is an additional guard, not a complete credential detector.

All current README screenshots are actual community UI captures using `DEMO_MODE=true`
with an isolated demo data directory and disabled external integrations. They contain generated
data only. iOS images are simulator captures of the community app against such a server; the
watch complication images render the app's complication views with the same synthetic reading. Replacing an image does not remove previous versions from Git history;
history removal requires a coordinated rewrite and cannot revoke existing clones.
