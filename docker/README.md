# ClearSugar Community — Docker stack

`docker-compose.yml` in this directory brings up the pieces ClearSugar reads
data from. It is generated (and prefilled) by `npm run setup` if you don't
already have a Nightscout site, but you can also copy/edit it by hand.

## Services

- **mongo** — MongoDB 6, the datastore Nightscout uses. Data persists in the
  `mongo-data` named volume. Not published to the host; only `nightscout`
  talks to it.
- **nightscout** — [Nightscout](https://github.com/nightscout/cgm-remote-monitor),
  the open-source CGM data server. Published on `127.0.0.1:1337` only (put a
  reverse proxy with HTTPS in front if you need to reach it off-box). Runs
  with the `bridge` plugin enabled, which pulls glucose readings from a
  Dexcom Share account.
- **tconnectsync** (optional, commented out by default) —
  [tconnectsync](https://github.com/jwoglom/tconnectsync) reads pump data
  from a Tandem t:connect account and uploads it to Nightscout as treatments.
  Only relevant if you have a Tandem pump.

## Data flow

```
Dexcom Share account --> Nightscout `bridge` plugin --> Nightscout (Mongo) --> ClearSugar
Tandem t:connect account --> tconnectsync --> Nightscout (Mongo) --> ClearSugar
```

ClearSugar itself never talks to Dexcom or Tandem directly — it only reads
from Nightscout's API (`NIGHTSCOUT_URL` / `NIGHTSCOUT_API_SECRET` in the
app's `.env`). Nightscout and tconnectsync do the upstream integration.

## Usage

```bash
cd docker
docker compose up -d
docker compose logs -f nightscout
```

Then set `NIGHTSCOUT_URL=http://localhost:1337` and
`NIGHTSCOUT_API_SECRET=<the API_SECRET you set above>` in the ClearSugar
app's `.env` (done automatically if `npm run setup` generated this file).

### Enabling tconnectsync

1. Uncomment the `tconnectsync` service block in `docker-compose.yml`.
2. Fill in `TCONNECT_EMAIL`, `TCONNECT_PASSWORD`, `TCONNECT_REGION`, and
   `NS_SECRET` (must match Nightscout's `API_SECRET`).
3. `docker compose up -d tconnectsync`

If you'd rather not run it in Docker, install it directly with
`pip install tconnectsync` — see
[the tconnectsync README](https://github.com/jwoglom/tconnectsync) for the
`.env` file and `--auto-update` / cron setup, and
`docs/install/INSTALL.md` in this repo for how it plugs into ClearSugar's
"Sync now" button via `scripts/tconnect-webhook.py`.

## Local overrides

Create `docker/docker-compose.override.yml` for host-specific tweaks (ports,
extra volumes, etc.) — it's gitignored so it won't get committed or clobbered
by updates.
