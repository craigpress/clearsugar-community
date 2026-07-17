# ClearSugar Companion App (iOS + watchOS)

Native iPhone and Apple Watch companion for your self-hosted ClearSugar server:
live glucose with trend and delta, 24h chart with treatments and predictions,
IOB/COB, configurable local alerts, home screen + lock screen widgets, Live
Activity / Dynamic Island, and watch complications.

```
┌──────────────────┐   HTTPS (JWT or API key)   ┌──────────────┐   WatchConnectivity   ┌──────────────┐
│ ClearSugar server│ ◄───────────────────────── │    iPhone    │ ────────────────────► │ Apple Watch  │
│  (Next.js, self- │   polling + optional APNs  │ app, widgets,│   sparkline, IOB/COB  │ app + compli-│
│     hosted)      │ ─────────────────────────► │ Live Activity│                       │   cations    │
└──────────────────┘                            └──────────────┘                       └──────────────┘
```

The phone polls the server (foreground timer + background refresh) and relays
data to the watch. The server can optionally push silent APNs updates to wake
the phone between polls — see "Push (optional)" below.

## Requirements

- A Mac with Xcode 16 or newer
- [XcodeGen](https://github.com/yonaskolb/XcodeGen): `brew install xcodegen`
- An Apple Developer account — the free tier works for everything except push
  (see below)
- A running ClearSugar server the phone can reach

## Setup

1. **Create `Config/Server.xcconfig`** (gitignored, one per install). Either
   run `npm run setup` on the server (the wizard writes it for you), or copy
   the example and edit:

   ```sh
   cp Config/Server.xcconfig.example Config/Server.xcconfig
   ```

   ```
   CLEARSUGAR_SERVER_URL = https:/$()/your-server.example.com
   CLEARSUGAR_BUNDLE_PREFIX = com.yourname.clearsugar
   DEVELOPMENT_TEAM = ABC123DEF4
   ```

   - The `$()` in the URL is required — xcconfig treats `//` as a comment.
   - Pick any unique reverse-DNS bundle prefix. All four targets, the app
     group, and the BGTask/Keychain identifiers derive from it.
   - `DEVELOPMENT_TEAM` is optional here; you can pick the team in Xcode
     instead.
   - You can leave the URL as the placeholder and enter the server URL in the
     app's setup screen instead (or scan the pairing QR from the dashboard).

2. **Generate the Xcode project** (the `.xcodeproj` is generated, never
   committed):

   ```sh
   xcodegen generate
   open ClearSugar.xcodeproj
   ```

3. **Set your signing team** in Xcode (Signing & Capabilities) for all four
   targets if you didn't put it in the xcconfig. Xcode creates the app group
   (`group.<your prefix>`) automatically for paid accounts; free accounts get
   a personal-team equivalent.

   **Free account note:** free (personal team) accounts cannot sign the push
   entitlement. If signing fails on the ClearSugar app target, delete the
   `aps-environment` key from `ClearSugar/ClearSugar.entitlements` — the app
   works fully via polling without it.

4. **Build to your iPhone** (select the ClearSugar scheme, pick your device).
   Free-account builds expire after 7 days — just rebuild.

5. **Pair the app**: open the app, then either scan the pairing QR from the
   web dashboard's "Mobile Setup" card (it fills in the server URL) or type
   the URL, and sign in with your ClearSugar username/password. Pasting an
   API key (`CLEARSUGAR_API_KEY` from the server's `.env`) also works.

## Watch app

Building the ClearSugar scheme to your iPhone also installs the watch app on
a paired Apple Watch (it may take a few minutes to appear; you can trigger it
from the Watch app on the phone under General → App Install). The watch
receives data from the phone over WatchConnectivity — it makes no network
calls of its own, so it works on any account tier. Complications can be added
from the watch face gallery once the watch app has received data at least
once.

## iOS version features

The app works fully on iOS 17+; newer OS versions add extras, all
availability-gated, so nothing below changes behavior on older devices:

- **iOS 26+:** opt-in urgent-low AlarmKit alarm (Settings → Alert Settings)
  that sounds through Silent/Focus with full-screen Stop and Open app buttons.
- **iOS 27:** extra-large-portrait home screen widget (iPad/Mac dashboards),
  a tightened Dynamic Island layout for landscape, and automatic Live
  Activity surfacing on CarPlay, StandBy, and the watch Smart Stack — the
  last three need no setup. The two SDK-gated code paths (extra-large widget,
  landscape island) need Xcode 27 to compile in; older Xcode compiles them
  out cleanly.

## What needs a paid Apple Developer account

| Feature | Free account | Paid account |
|---|---|---|
| App, chart, alerts, watch app, complications, widgets | Yes (7-day resign) | Yes |
| Background refresh polling (5–15 min) | Yes | Yes |
| Dead-man "no data" watchdog notification | Yes | Yes |
| APNs push (server-driven updates, remote alerts) | No | Yes |
| Live Activity updated remotely via push | No | Yes (local-only updates work free) |
| TestFlight distribution | No | Yes |

Push is strictly optional: registration failures are caught and the app falls
back to polling everywhere.

## Push (optional, server side)

If you have a paid account and want server-driven updates, configure the
server's push sender (see the `deploy/` units and the `APNS_*` variables in
the server's `.env.example`): an APNs key from your developer account, your
team ID, and the app bundle ID (your `CLEARSUGAR_BUNDLE_PREFIX`). The app
registers its device and Live Activity tokens with the server automatically
after sign-in. Development (Xcode) builds use the APNs sandbox; TestFlight/App
Store builds use production — set the matching `aps-environment` and server
config.

## Reaching the server away from home

The default LAN-only server deployment (plain HTTP on a private LAN IP, e.g.
`http://<lan-ip>:3000`) only works while the phone is on your home network.
The app ships with `NSAllowsLocalNetworking`, so plain-HTTP LAN URLs work on
the home Wi-Fi without any ATS overrides — but away from home you need one
of:

- **Tailscale (recommended):** run `tailscale serve` on the server host and
  use the HTTPS `https://<host>.<tailnet>.ts.net` URL in the app. Note that
  raw Tailscale `100.x.x.x` IPs are **not** covered by the local-networking
  exception — use the `ts.net` HTTPS URL, not the bare IP.
- **A reverse proxy with a real TLS certificate** (Caddy, nginx +
  Let's Encrypt, Cloudflare Tunnel) in front of the server.

iOS 17+ will prompt once for Local Network permission when you first connect
to a LAN address.

## Project layout

```
ios/
├── project.yml                  # XcodeGen spec — run `xcodegen generate`
├── Config/Server.xcconfig       # your server/bundle config (gitignored)
├── ClearSugar/                  # iOS app
│   ├── App/                     # entry point, APNs + BGTask wiring
│   ├── Models/                  # APIClient (all server endpoints), data models
│   ├── Services/                # auth, alerts, cache, Live Activity, watch bridge
│   ├── Shared/                  # AppConfig + Live Activity attributes (all targets)
│   ├── Views/                   # main screen, chart, settings, setup, QR scanner
│   └── Widgets/                 # home/lock screen widgets + Live Activity UI
└── ClearSugarWatch/             # watchOS app + complications
```
