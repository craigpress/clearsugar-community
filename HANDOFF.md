# Community ClearSugar handoff — 2026-10-04

## State

README now has iOS/watch screenshots and a "Background updates, Live Activities, and alert
delivery" section (`0e99688`): background-refresh limits, push-updated Live Activities (~8 h
iOS cap, opt-in `LIVE_ACTIVITY_PUSH_TO_START`), server-pushed alerts with local backstop,
Home Assistant as a private-only option (offer on request), and critical alerts pending
Apple's entitlement (urgent alerts currently arrive time-sensitive; AlarmKit urgent-low on
iOS 26+ already breaks Silent).

Chart fixes (`791fd75`, `ba113e8`, mirrored in clearsugar-ios): watch y labels 70/180/top
(≥250) with the fixed y column reserving the x-label row; watch and iPhone charts skip hour
labels near domain edges; watch uses a 2 h stride above 4 h visible; iPhone glucose plot pads
its top label; basal strip labels 1 and 2 U/hr only. Built for iOS 26.5 / watchOS 26.5
simulators and inspected visually; iOS unit tests were not rerun.

Images (`docs/screenshots/ios-iphone.jpg`, `ios-dynamic-island.jpg`, `ios-watch.jpg`) were
captured in one pass at 209 mg/dL from a `DEMO_MODE=true` server. Watch complications are
the app's complication views rendered with `ImageRenderer`, not on a watch face (the
simulator could not download faces with complication slots). Privacy scan passed on each
commit. Earlier 2026-09-29 state (meal profiles/photos, history rewrite, 584 web tests,
CI `36589794731`) is carried forward unrechecked.

## Next

- Verify physical-device camera, offline retry, notification actions and APNs delivery
  with an operator's own configuration; simulator success does not establish delivery.
- Configure an optional vision provider and meal detector schedule per docs/MEALS.md
  (additional profiles are local meal journals, not independent Nightscout dashboards).
- If someone asks, add an optional Home Assistant alert sender (README offers it).

## Context

Screenshot harness lives only on the Mac in `~/cs-shots` (scratch copy of this repo,
`ClearSugarUITests/ScreenshotTests.swift`, `RenderHarness/`, `runtest.sh`, demo `.env` and a
local test API key). Re-run: `npx next dev -p 3000 -H 127.0.0.1` there, then
`~/cs-shots/runtest.sh test5_Final`; watch shots via `simctl io`; complications via the
`Render` scheme. Lock-screen editing lives in the `com.apple.PosterBoard` process; long
presses need retries; pressing home lands on the widgets page.

The repository is public. Runtime profile/account data and photos belong only in the data
directory. Keep local identity-denylist entries in Git metadata. Private SSO, home
automation, deployment/signing settings and clinical records are excluded. See
docs/COMMUNITY_SYNC.md for the import policy.
