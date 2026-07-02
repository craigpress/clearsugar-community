#!/usr/bin/env python3
"""
tconnectsync webhook listener for the Nightscout host running tconnectsync.

A minimal HTTP server that restarts the tconnectsync service on demand so the
ClearSugar app can force an immediate pull from Tandem t:connect.

Endpoints:
  POST /sync    -> requires `Authorization: Bearer <WEBHOOK_TOKEN>`; restarts
                   tconnectsync.service and returns {ok, status, timestamp}.
                   Returns 401 without a valid token.
  GET  /health  -> no auth; returns {ok, tconnectsync: <active|...>}.
  OPTIONS *     -> CORS preflight.

The ClearSugar app calls these via TCONNECT_WEBHOOK_URL and sends the token from
TCONNECT_WEBHOOK_TOKEN (see src/app/api/sync/route.ts). Keep the token in sync
between the app .env (TCONNECT_WEBHOOK_TOKEN) and this service (WEBHOOK_TOKEN).

Install on the Nightscout/tconnectsync host:
  1. cp scripts/tconnect-webhook.py /opt/tconnect-webhook.py
  2. cp scripts/tconnect-webhook.service /etc/systemd/system/
  3. Edit the WEBHOOK_TOKEN in the unit file (or an EnvironmentFile) to a
     value matching TCONNECT_WEBHOOK_TOKEN in the app's .env.
  4. systemctl daemon-reload && systemctl enable --now tconnect-webhook

Security: bound to 0.0.0.0:9876. If exposed beyond localhost/LAN, put it
behind a reverse proxy with HTTPS — the bearer token on /sync is the only
access control. WEBHOOK_TOKEN must be set via the env var (no default); the
server refuses to start without one.
"""
import http.server
import json
import os
import subprocess
import sys
import time

PORT = int(os.environ.get("WEBHOOK_PORT", "9876"))
AUTH_TOKEN = os.environ.get("WEBHOOK_TOKEN", "")

if not AUTH_TOKEN:
    print("ERROR: WEBHOOK_TOKEN env var is required (no default token).", flush=True)
    sys.exit(1)


class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/sync":
            self.send_error(404)
            return
        token = self.headers.get("Authorization", "").replace("Bearer ", "")
        if token != AUTH_TOKEN:
            self.send_error(401)
            return
        r = subprocess.run(
            ["systemctl", "restart", "tconnectsync.service"],
            capture_output=True, text=True, timeout=10,
        )
        s = subprocess.run(
            ["systemctl", "is-active", "tconnectsync.service"],
            capture_output=True, text=True, timeout=5,
        )
        resp = {
            "ok": r.returncode == 0,
            "status": s.stdout.strip(),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        self.send_response(200 if r.returncode == 0 else 500)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(resp).encode())

    def do_GET(self):
        if self.path == "/health":
            s = subprocess.run(
                ["systemctl", "is-active", "tconnectsync.service"],
                capture_output=True, text=True, timeout=5,
            )
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(
                json.dumps({"ok": True, "tconnectsync": s.stdout.strip()}).encode()
            )
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.end_headers()

    def log_message(self, fmt, *args):
        print(f"[webhook] {args[0]}", flush=True)


if __name__ == "__main__":
    srv = http.server.HTTPServer(("0.0.0.0", PORT), H)
    print(f"tconnect-webhook :{PORT}", flush=True)
    srv.serve_forever()
