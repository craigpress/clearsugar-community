# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities. Instead, use GitHub's
private vulnerability reporting ("Report a vulnerability" under the Security tab) so the
issue can be fixed before details are public.

You can expect an initial response within a week.

## Scope and threat model

ClearSugar is a **self-hosted** application that handles sensitive health data. The security
model assumes:

- The server runs on hardware you control (home server, VPS, Raspberry Pi).
- All web access requires authentication (username/password, bcrypt-hashed at cost 12).
- Machine clients (timers, companion apps) authenticate with a random per-install API key.
- Secrets live only in your local `.env` file and are never transmitted anywhere except to
  the services you explicitly configure (your Nightscout, your chosen AI provider).

## Hardening recommendations

- Put ClearSugar behind HTTPS (reverse proxy with a real certificate) **before** exposing it
  off your LAN. Never expose it over plain HTTP to the internet.
- Keep Nightscout bound to localhost (or your LAN) unless you independently secure it —
  ClearSugar talks to it server-side, so Nightscout does not need to be public.
- Use a long, unique admin password. The setup wizard enforces a minimum, but longer is better.
- Restrict filesystem permissions on `.env` and the data directory to the service user.
- Keep dependencies updated (`npm audit`, Dependabot).

## Medical safety

ClearSugar is **not a medical device**. It must never be your only alerting system for
hypo- or hyperglycemia. Always keep your CGM manufacturer's app and alarms active.
