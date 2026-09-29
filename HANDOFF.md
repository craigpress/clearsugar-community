# Community ClearSugar handoff — 2026-09-29

## State

Published generalized shared server/iOS reliability updates and family meal/photo workflows
as `e71aae3`; GitHub CI `36589794731` passed after the approved force-with-lease rewrite.
Owners manage named profiles and explicit local-account assignments. Only the primary
profile mirrors confirmed uncovered carbohydrates to Nightscout; other profiles have
isolated local journals. Photos are metadata-stripped and authorized by profile. Optional
OpenAI-compatible vision estimates support revisions and require human confirmation.
iOS includes photo/meal entry, prompt actions and account/server-scoped queued saves.

Validation: 584 web tests, TypeScript, production build, and 52 Xcode 27 simulator tests
pass. Browser checks cover profile creation, image upload, manual save without a vision
provider, profile switching and undo. Dependency/secret/privacy scans pass. README has
13 synthetic screenshots. No private deployment or TestFlight release was changed.

The approved history rewrite removes historical screenshots, handoffs, README and alert
documentation (including old personal clinical summaries) while
preserving code history, then restores the current synthetic images and this handoff.
Retained historical text was scanned for private identities, paths and addresses; Gitleaks
found no credentials. Local recovery bundles preserve the previous history. Remote main
was verified; no remote tags, other branches, open PRs or forks were present. Cached
commits or existing clones cannot be revoked by a force-push. Existing clones should
re-clone or carefully reset to the rewritten main, never merge the old history back.

## Next

- Verify physical-device camera, offline retry, notification actions and APNs delivery
  with an operator's own configuration; simulator success does not establish delivery.
- Additional profiles are local meal journals, not independent Nightscout dashboards.
- Configure an optional vision provider and meal detector schedule per docs/MEALS.md.

## Context

The repository is public. Runtime profile/account data and photos belong only in the data
directory. Keep local identity-denylist entries in Git metadata. Generic privacy checks run
in CI. Private SSO, home automation, deployment/signing settings and clinical records are
excluded. Build tracing still emits broad-path warnings; private runtime paths are excluded
from standalone output. See docs/COMMUNITY_SYNC.md for the import policy.
