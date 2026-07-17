# Installing ClearSugar Community

ClearSugar is a self-hosted dashboard and prediction aid for Type 1 Diabetes
data, built on Nightscout. **It is not a medical device.** It does not
replace your CGM's or pump's own alarms and must not be your only alerting
system. Keep your CGM/pump manufacturer's official apps and alarms active.

## Prerequisites

- **Node.js 20+** and npm
- **Docker + Docker Compose** (optional — only needed if you want ClearSugar
  to generate a local Nightscout + MongoDB stack for you; skip if you already
  run Nightscout elsewhere)
- **Python 3.11+** (optional — only needed for the ML prediction/training
  scripts in `scripts/`, and for `tconnectsync` if you install it via pip)
- A Dexcom Share account (for CGM data) and, optionally, a Tandem t:connect
  account (for pump data)

## 1. Clone and install

```bash
git clone <this-repo-url> clearsugar
cd clearsugar
npm install
```

## 2. Run the setup wizard

```bash
npm run setup
```

This interactive wizard (`scripts/setup.mjs`) will:

- Show the medical-safety disclaimer (must be acknowledged to continue)
- Ask whether you already have a Nightscout site, or generate
  `docker/docker-compose.yml` (Nightscout + MongoDB, with the Dexcom Share
  `bridge` plugin) for you
- Optionally configure a Tandem pump / tconnectsync integration
- Ask for the patient's profile (name, age, CGM/pump model, clinical notes)
  and create the first admin account
- Optionally configure an AI insights provider (Anthropic API, Claude Code
  CLI, Codex CLI, a local Ollama model, or any OpenAI-compatible server)
- Optionally configure remote access (see below)
- Optionally configure the iOS companion app — writes
  `ios/Config/Server.xcconfig` with your server URL and bundle identifier
  (the app itself is built with Xcode on a Mac; see
  [`ios/README.md`](../../ios/README.md))
- Generate all required secrets and write `.env`

Re-run `npm run setup` any time to reconfigure — it will back up your
existing `.env` before overwriting it.

## 3. Start Nightscout (if the wizard generated a compose file)

```bash
cd docker
docker compose up -d
docker compose logs -f nightscout
cd ..
```

Nightscout will be reachable at `http://localhost:1337`. See
[`docker/README.md`](../../docker/README.md) for what each service does and
how the Dexcom Share bridge / tconnectsync data flow works.

If you already run your own Nightscout instance, skip this step — the
wizard already pointed `NIGHTSCOUT_URL` / `NIGHTSCOUT_API_SECRET` at it.

## 4. Build and run

```bash
npm run build
npm start
```

The app listens on port 3000 by default. Open `http://localhost:3000` and
log in with the admin account you created in the setup wizard.

## 5. Persistent install with systemd (optional)

For a server that should keep running after you log out or reboot, adapt
[`deploy/clearsugar.service`](../../deploy/clearsugar.service):

```ini
[Unit]
Description=ClearSugar Next.js App
After=network.target mongod.service

[Service]
Type=simple
User=clearsugar
WorkingDirectory=/opt/clearsugar/app
EnvironmentFile=/opt/clearsugar/app/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

1. Copy the standalone build to `/opt/clearsugar/app` (or your chosen
   directory) — see `deploy/deploy.sh` / `deploy/deploy-tar.sh` for scripted
   rsync/tar-over-ssh deploys (set `DEPLOY_HOST` and, if you're not using
   `/opt/clearsugar/app`, `DEPLOY_APP_DIR`).
2. Copy `.env` to that directory (the unit's `EnvironmentFile=` must point
   at it).
3. Create a dedicated `clearsugar` system user, or edit `User=` in the unit
   file to match your setup.
4. Install and enable:
   ```bash
   sudo cp deploy/clearsugar.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now clearsugar
   ```

The `deploy/clearsugar-*.timer` / `.service` pairs run the periodic alert
check, Live Activity push, and action-advisor jobs via `systemd` timers —
install them the same way if you use those features. Each one calls a
`localhost:3000` API route with `X-API-Key: $CLEARSUGAR_API_KEY` from the
same `EnvironmentFile`.

## Remote access

By default ClearSugar is only reachable on your local network
(`localhost` / your LAN IP on port 3000). If you want to reach it when
you're away from home, pick one of these:

### LAN only (default)

No changes needed. Use the app over your home Wi-Fi or VPN into your home
network by other means.

### Tailscale (recommended if you don't have a domain name)

[Tailscale](https://tailscale.com) creates a private mesh network (a
"tailnet") between your devices with no open ports on your router. It's the
easiest secure option for a family self-hosting a single app like this.

1. Install Tailscale on the server: https://tailscale.com/download
2. `sudo tailscale up` and follow the login prompt to join your tailnet.
3. Install Tailscale on your phone(s) and any other device you want to use
   ClearSugar from — once they're on the same tailnet, they can reach the
   server directly.
4. Expose ClearSugar with automatic HTTPS:
   ```bash
   tailscale serve --bg 3000
   ```
   This gives you a URL like `https://your-machine.your-tailnet.ts.net` with
   a valid, automatically-renewed TLS certificate — no reverse proxy or
   certificate management needed. It's reachable only from devices on your
   tailnet.
5. Set `APP_URL=https://your-machine.your-tailnet.ts.net` in `.env` (the
   setup wizard does this for you if you choose Tailscale in the "Remote
   access" step) so QR pairing (mobile companion app) and generated links
   use the right host.

Alternatively, skip `tailscale serve` and just use the plain tailnet IP
(`tailscale ip`) with `http://<tailscale-ip>:3000` — still private to your
tailnet, but without a certificate.

**Zero ports need to be opened on your router for either option.**

### Reverse proxy with your own domain

If you already have a domain and are comfortable running a reverse proxy
(nginx, Caddy, Nginx Proxy Manager, Traefik, etc.), put it in front of
ClearSugar and terminate HTTPS there. Set `APP_URL` to your public
`https://` URL.

**Never expose ClearSugar to the internet without HTTPS, and never expose it
without the app's own authentication in front of it.** ClearSugar's
NextAuth login is the only gate on the web UI — don't disable it, and don't
put it behind a proxy that strips authentication.

## Backups

Back up two things:

- **The data directory** (`CLEARSUGAR_DATA_DIR`, default `./.data` in dev or
  `/opt/clearsugar/data` in production) — contains the admin account,
  patient profile, alert state, and generated reports.
- **`.env`** — contains all secrets and configuration. Losing it means
  regenerating secrets and reconfiguring integrations (existing data in the
  data directory and Nightscout is unaffected, but sessions/API keys will
  need to be reissued).

Neither is committed to git (`.env*` and `.data/` are gitignored) — back
them up yourself, e.g. with a nightly `tar` + off-host copy.

If you're running the generated Nightscout/MongoDB stack, also back up the
`mongo-data` Docker volume — it holds all CGM/treatment history.

## Updating

See [`UPDATING.md`](./UPDATING.md).
