# Updating ClearSugar Community

## Standard update (running from source)

```bash
git pull
npm install
npm run build
```

Then restart the app:

- Running via `npm start` in a terminal: stop it (Ctrl-C) and start it again.
- Running via systemd:
  ```bash
  sudo systemctl restart clearsugar
  ```

## If new environment variables were added

Check [`.env.example`](../../.env.example) for anything new and add it to
your `.env`. Re-running `npm run setup` will back up your existing `.env`
(to `.env.backup-<timestamp>`) and let you regenerate it interactively —
useful after a release that adds new configuration, but review the backup
if you've hand-edited `.env` since your last setup run.

## Nightscout / MongoDB (if using the generated Docker stack)

```bash
cd docker
docker compose pull
docker compose up -d
```

## Deploying to a remote host

If you deploy the standalone build to a separate server (see
`deploy/deploy.sh` / `deploy/deploy-tar.sh`), rebuild first, then run the
script with the target host set:

```bash
npm run build
DEPLOY_HOST=user@your-host ./deploy/deploy.sh
```

This restarts the `clearsugar` systemd service on the target after copying
the build over, preserving the remote `.env`.

## Rollback

If an update causes problems:

- **App**: `git checkout <previous-tag-or-commit>`, `npm install`,
  `npm run build`, restart.
- **Data**: restore the data directory and/or Mongo volume from your most
  recent backup (see the "Backups" section in
  [`INSTALL.md`](./INSTALL.md#backups)).
