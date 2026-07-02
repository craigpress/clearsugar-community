#!/usr/bin/env node
/**
 * ClearSugar Community — interactive setup wizard.
 *
 * Run via `npm run setup`. Walks through Nightscout, an optional Tandem
 * pump / tconnectsync integration, the patient profile, an admin account,
 * optional AI insights, and optional remote-access configuration, then
 * writes `.env` (and, if requested, `docker/docker-compose.yml`).
 *
 * Node-only — no external deps besides bcryptjs (already a project
 * dependency; see package.json).
 */

import * as readline from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile, rename, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(REPO_ROOT, ".env");
const COMPOSE_PATH = path.join(REPO_ROOT, "docker", "docker-compose.yml");

const { stdin: input, stdout: output } = process;
let rl = readline.createInterface({ input, output });

// ── Small prompt helpers ────────────────────────────────────────────────────

async function ask(prompt, { defaultValue = "" } = {}) {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function askYesNo(prompt, defaultYes = true) {
  const suffix = defaultYes ? " [Y/n]" : " [y/N]";
  const answer = (await rl.question(`${prompt}${suffix}: `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith("y");
}

async function askChoice(prompt, options, defaultIndex = 0) {
  console.log(prompt);
  options.forEach((opt, i) => console.log(`  ${i + 1}) ${opt}`));
  for (;;) {
    const answer = (
      await rl.question(`Choose [1-${options.length}] (default ${defaultIndex + 1}): `)
    ).trim();
    if (!answer) return defaultIndex + 1;
    const n = Number.parseInt(answer, 10);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n;
    console.log(`Please enter a number from 1 to ${options.length}.`);
  }
}

// Key codes used by askHidden's raw-mode input handling below. Written as
// numeric char codes (not escape-sequence literals) for clarity and to avoid
// any ambiguity about which control character is meant.
const KEY_LF = 10; // line feed ("\n")
const KEY_CR = 13; // carriage return ("\r")
const KEY_EOT = 4; // Ctrl-D
const KEY_ETX = 3; // Ctrl-C
const KEY_DEL = 127; // Delete (most terminals' backspace key)
const KEY_BS = 8; // Backspace (some terminals)

/** Masked (password-style) prompt. Falls back to plain text if stdin isn't a TTY. */
async function askHidden(prompt) {
  if (!input.isTTY) {
    console.log("  (warning: input is not a TTY -- this will be shown as you type)");
    return (await rl.question(`${prompt}: `)).trim();
  }
  // Reading raw keystrokes conflicts with readline's own stdin listeners, so
  // close and later recreate the interface around this raw-mode read.
  rl.close();
  const value = await new Promise((resolve) => {
    output.write(`${prompt}: `);
    let buf = "";
    const onData = (chunk) => {
      const s = chunk.toString("utf8");
      for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (code === KEY_LF || code === KEY_CR || code === KEY_EOT) {
          input.setRawMode(false);
          input.pause();
          input.removeListener("data", onData);
          output.write("\n");
          resolve(buf);
          return;
        }
        if (code === KEY_ETX) {
          output.write("\n");
          process.exit(130);
        }
        if (code === KEY_DEL || code === KEY_BS) {
          if (buf.length) {
            buf = buf.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        buf += s[i];
        output.write("*");
      }
    };
    input.setEncoding("utf8");
    input.resume();
    input.setRawMode(true);
    input.on("data", onData);
  });
  rl = readline.createInterface({ input, output });
  return value.trim();
}

function genSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function genHex(bytes = 16) {
  return randomBytes(bytes).toString("hex");
}

function escapeYaml(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function checkCli(cmd, versionArg = "--version") {
  try {
    const result = spawnSync(cmd, [versionArg], { shell: true, encoding: "utf8" });
    return result.status === 0;
  } catch {
    return false;
  }
}

async function offerGlobalInstall(pkgName, cmdName) {
  const yes = await askYesNo(
    `${cmdName} was not found on PATH. Run "npm install -g ${pkgName}" now?`,
    false,
  );
  if (!yes) {
    console.log(`  Skipped. Install later with: npm install -g ${pkgName}`);
    return false;
  }
  console.log(`  Running: npm install -g ${pkgName}`);
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCmd, ["install", "-g", pkgName], {
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) {
    console.log(`  Install failed (exit ${result.status}). You can retry manually later.`);
    return false;
  }
  return true;
}

// ── Welcome + medical disclaimer ────────────────────────────────────────────

async function stepDisclaimer() {
  console.log("");
  console.log("======================================================================");
  console.log(" ClearSugar Community -- setup wizard");
  console.log("======================================================================");
  console.log(`
ClearSugar is a self-hosted dashboard and prediction aid for Type 1 Diabetes
data. It is NOT a medical device. It is not FDA-cleared, does not replace
your CGM's or pump's own alarms, and must NOT be relied upon as your only
alerting system for hypoglycemia, hyperglycemia, or device failures. Always
keep your CGM/pump manufacturer's official alarms and apps active.

By continuing, you acknowledge that you understand this and accept
responsibility for how you use this software.
`);
  const ok = await askYesNo("I understand -- continue with setup?", false);
  if (!ok) {
    console.log("Setup cancelled.");
    process.exit(0);
  }
}

// ── Nightscout ───────────────────────────────────────────────────────────────

async function stepNightscout() {
  console.log("\n--- Nightscout ---");
  const hasSite = await askYesNo("Do you already have a Nightscout site running?", true);

  if (hasSite) {
    const nightscoutUrl = await ask("Nightscout URL", {
      defaultValue: "http://localhost:1337",
    });
    const nightscoutApiSecret = await ask("Nightscout API secret");

    console.log("  Testing connection...");
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${nightscoutUrl.replace(/\/$/, "")}/api/v1/status.json`, {
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        console.log("  Connected OK.");
      } else {
        console.log(`  Warning: Nightscout responded with HTTP ${res.status}. Continuing anyway.`);
      }
    } catch (err) {
      console.log(`  Warning: could not reach Nightscout (${err.message}). Continuing anyway.`);
    }

    return {
      nightscoutUrl,
      nightscoutApiSecret,
      generateCompose: false,
      composeApiSecret: null,
      bridgeUser: "",
      bridgePassword: "",
    };
  }

  console.log(`
No problem -- ClearSugar can generate a local Nightscout + MongoDB stack for
you via Docker Compose (docker/docker-compose.yml).

Dexcom Share bridge: Nightscout's built-in "bridge" plugin pulls glucose
readings from your Dexcom Share account (the same account/password used by
the Dexcom Share / Follow app) and writes them into Nightscout. It's
configured with the BRIDGE_USER_NAME / BRIDGE_PASSWORD environment
variables on the Nightscout container.
`);

  const generateCompose = await askYesNo(
    "Generate docker/docker-compose.yml now (Nightscout + MongoDB)?",
    true,
  );

  const nightscoutUrl = "http://localhost:1337";
  const composeApiSecret = genHex(16);

  let bridgeUser = "";
  let bridgePassword = "";
  if (generateCompose) {
    bridgeUser = await ask(
      "Dexcom Share username (optional -- press Enter to skip and fill in later)",
    );
    if (bridgeUser) {
      bridgePassword = await askHidden("Dexcom Share password");
    }
  }

  return {
    nightscoutUrl,
    nightscoutApiSecret: composeApiSecret,
    generateCompose,
    composeApiSecret,
    bridgeUser,
    bridgePassword,
  };
}

// ── Tandem pump / tconnectsync ───────────────────────────────────────────────

async function stepTandem(ns) {
  console.log("\n--- Tandem pump (optional) ---");
  const wantsTandem = await askYesNo(
    "Do you have a Tandem pump + t:connect account you'd like to sync via tconnectsync?",
    false,
  );

  const result = {
    includeTconnectInCompose: false,
    tconnect: null,
    tconnectWebhookUrl: "",
    tconnectWebhookToken: "",
  };

  if (!wantsTandem) return result;

  console.log(`
tconnectsync (https://github.com/jwoglom/tconnectsync) reads pump data from
your Tandem t:connect account and uploads it to Nightscout as treatments,
which ClearSugar then reads.
`);

  if (ns.generateCompose) {
    const includeInCompose = await askYesNo(
      "Add a tconnectsync service to docker/docker-compose.yml?",
      true,
    );
    if (includeInCompose) {
      const email = await ask("t:connect email");
      const password = await askHidden("t:connect password");
      const region = await ask("t:connect region (US or EU)", { defaultValue: "US" });
      const timezone = await ask("Pump timezone (IANA name, e.g. America/New_York)", {
        defaultValue: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York",
      });
      result.includeTconnectInCompose = true;
      result.tconnect = { email, password, region, timezone };
    }
  } else {
    console.log(`
Since you already have your own Nightscout, install tconnectsync directly:
  pip install tconnectsync
See docs/install/INSTALL.md and https://github.com/jwoglom/tconnectsync for
the .env file it needs and how to run it continuously (supervisord/cron).
`);
  }

  const wantsWebhook = await askYesNo(
    'Set up the "Sync now" webhook so ClearSugar can trigger an immediate ' +
      "tconnectsync pull on demand? (requires installing scripts/tconnect-webhook.py " +
      "on your Nightscout host -- see docs/install/INSTALL.md)",
    false,
  );
  if (wantsWebhook) {
    result.tconnectWebhookToken = genSecret(24);
    result.tconnectWebhookUrl = await ask("tconnect-webhook URL", {
      defaultValue: "http://localhost:9876",
    });
    console.log(
      "  Generated TCONNECT_WEBHOOK_TOKEN. Set the same value as WEBHOOK_TOKEN in " +
        "scripts/tconnect-webhook.service when you install it.",
    );
  }

  return result;
}

// ── docker-compose.yml generation ───────────────────────────────────────────

function buildComposeYaml({ apiSecret, bridgeUser, bridgePassword, includeTconnect, tconnect }) {
  const bridgeLines =
    bridgeUser && bridgePassword
      ? `      BRIDGE_USER_NAME: "${escapeYaml(bridgeUser)}"\n      BRIDGE_PASSWORD: "${escapeYaml(bridgePassword)}"`
      : `      # BRIDGE_USER_NAME: "your-dexcom-share-username"\n      # BRIDGE_PASSWORD: "your-dexcom-share-password"`;

  const tconnectBlock = includeTconnect
    ? `
  tconnectsync:
    image: ghcr.io/jwoglom/tconnectsync/tconnectsync:latest
    container_name: clearsugar-tconnectsync
    restart: unless-stopped
    depends_on:
      - nightscout
    environment:
      TCONNECT_EMAIL: "${escapeYaml(tconnect.email)}"
      TCONNECT_PASSWORD: "${escapeYaml(tconnect.password)}"
      TCONNECT_REGION: "${escapeYaml(tconnect.region)}"
      NS_URL: "http://nightscout:1337"
      NS_SECRET: "${escapeYaml(apiSecret)}"
      TIMEZONE_NAME: "${escapeYaml(tconnect.timezone)}"
    command: ["--auto-update"]
`
    : `
  # Optional: tconnectsync pulls Tandem t:connect pump data into Nightscout.
  # Uncomment if you have a Tandem pump + t:connect account. See
  # docker/README.md and docs/install/INSTALL.md, or run it via pip instead
  # (pip install tconnectsync) if you prefer not to use Docker.
  #
  # tconnectsync:
  #   image: ghcr.io/jwoglom/tconnectsync/tconnectsync:latest
  #   container_name: clearsugar-tconnectsync
  #   restart: unless-stopped
  #   depends_on:
  #     - nightscout
  #   environment:
  #     TCONNECT_EMAIL: "your-tconnect-email"
  #     TCONNECT_PASSWORD: "your-tconnect-password"
  #     TCONNECT_REGION: "US" # or "EU"
  #     NS_URL: "http://nightscout:1337"
  #     NS_SECRET: "${escapeYaml(apiSecret)}"
  #     TIMEZONE_NAME: "America/New_York"
  #   command: ["--auto-update"]
`;

  const tz = tconnect?.timezone || "America/New_York";

  return `version: "3.8"

# ClearSugar Community — Nightscout stack.
# Generated by \`npm run setup\` on ${new Date().toISOString()}.
#
# NOTE: this file now contains a generated Nightscout API secret${
    includeTconnect ? " and t:connect credentials" : ""
  }.
# If you plan to publish changes to a fork of this repo, do not commit this
# file with real secrets in it -- restore the template from git or scrub the
# values first.
#
# Data flow:
#   Dexcom Share account -> Nightscout \`bridge\` plugin -> Nightscout (Mongo) -> ClearSugar
${includeTconnect ? "#   Tandem t:connect account -> tconnectsync -> Nightscout (Mongo) -> ClearSugar\n" : ""}
services:
  mongo:
    image: mongo:6
    container_name: clearsugar-mongo
    restart: unless-stopped
    volumes:
      - mongo-data:/data/db

  nightscout:
    image: nightscout/cgm-remote-monitor:latest
    container_name: clearsugar-nightscout
    restart: unless-stopped
    depends_on:
      - mongo
    ports:
      - "127.0.0.1:1337:1337"
    environment:
      MONGO_CONNECTION: mongodb://mongo:27017/nightscout
      API_SECRET: "${escapeYaml(apiSecret)}"
      ENABLE: "bridge careportal iob cob basal"
      INSECURE_USE_HTTP: "true"
      TZ: "${tz}"
${bridgeLines}
${tconnectBlock}
volumes:
  mongo-data:
`;
}

// ── Patient profile ──────────────────────────────────────────────────────────

async function stepProfile() {
  console.log("\n--- Patient profile ---");
  const name = await ask("Patient name (used in UI copy and AI prompts)");
  const ageRaw = await ask("Age in years (optional)");
  const ageYears = ageRaw && Number.isFinite(Number(ageRaw)) ? Number(ageRaw) : null;
  const cgm = await ask("CGM model (e.g. Dexcom G7)");
  const pump = await ask("Pump model (e.g. Tandem t:slim X2, or 'MDI' if not on a pump)");
  const clinicalNotes = await ask("Clinical notes for AI insights context (optional)");

  return {
    name,
    ageYears,
    cgm,
    pump,
    insulinNotes: "",
    clinicalNotes,
  };
}

// ── Admin account ────────────────────────────────────────────────────────────

async function stepAdmin() {
  console.log("\n--- Admin account ---");
  const username = await ask("Admin username");
  let password = "";
  for (;;) {
    password = await askHidden("Admin password (min 8 characters)");
    if (password.length >= 8) break;
    console.log("  Password must be at least 8 characters.");
  }
  const passwordHash = await bcrypt.hash(password, 12);
  return {
    username,
    passwordHash,
    role: "owner",
    createdAt: new Date().toISOString(),
  };
}

// ── AI insights ──────────────────────────────────────────────────────────────

async function stepAiInsights() {
  console.log("\n--- AI insights (optional) ---");
  const choice = await askChoice(
    "How should ClearSugar generate AI insights reports?",
    [
      "Anthropic API (cloud, requires an API key)",
      "Claude Code CLI (local, requires the `claude` CLI)",
      "Codex CLI (local, requires the `codex` CLI)",
      "Local LLM via Ollama",
      "Any OpenAI-compatible server",
      "None / skip for now",
    ],
    5,
  );

  const vals = {
    llmProvider: "none",
    anthropicApiKey: "",
    anthropicModel: "claude-sonnet-5",
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "",
    openaiCompatUrl: "",
    openaiCompatApiKey: "",
    openaiCompatModel: "",
    claudeCliPath: "claude",
    codexCliPath: "codex",
  };

  switch (choice) {
    case 1: {
      vals.llmProvider = "anthropic";
      vals.anthropicApiKey = await askHidden("Anthropic API key");
      vals.anthropicModel = await ask("Anthropic model", {
        defaultValue: "claude-sonnet-5",
      });
      console.log("  Note: the key is stored only in your local .env, never sent anywhere else.");
      break;
    }
    case 2: {
      vals.llmProvider = "claude-cli";
      if (!checkCli("claude")) {
        await offerGlobalInstall("@anthropic-ai/claude-code", "claude");
      } else {
        console.log("  Found `claude` on PATH.");
      }
      break;
    }
    case 3: {
      vals.llmProvider = "codex-cli";
      if (!checkCli("codex")) {
        await offerGlobalInstall("@openai/codex", "codex");
      } else {
        console.log("  Found `codex` on PATH.");
      }
      break;
    }
    case 4: {
      vals.llmProvider = "ollama";
      vals.ollamaUrl = await ask("Ollama URL", { defaultValue: "http://localhost:11434" });
      vals.ollamaModel = await ask("Ollama model (e.g. llama3.1)");
      break;
    }
    case 5: {
      vals.llmProvider = "openai-compatible";
      vals.openaiCompatUrl = await ask("Server base URL");
      vals.openaiCompatApiKey = await askHidden("API key (leave blank if none)");
      vals.openaiCompatModel = await ask("Model name");
      break;
    }
    default:
      vals.llmProvider = "none";
  }

  return vals;
}

// ── Remote access ────────────────────────────────────────────────────────────

async function stepRemoteAccess() {
  console.log("\n--- Remote access (optional) ---");
  const choice = await askChoice(
    "How will you reach ClearSugar when you're not on your home network?",
    [
      "LAN only -- no remote access (default)",
      "Tailscale (recommended if you don't have a domain name)",
      "Reverse proxy with my own domain",
    ],
    0,
  );

  let appUrl = "";

  if (choice === 2) {
    const hasTailscale = checkCli("tailscale", "version");
    if (!hasTailscale) {
      console.log(`
Tailscale was not found on PATH. Install it from https://tailscale.com/download,
then run \`tailscale up\` to join your tailnet. Re-run "npm run setup" (or edit
.env by hand) afterwards to set APP_URL.
`);
    } else {
      console.log(`
Tailscale is installed. Two ways to reach ClearSugar over your tailnet:

  1. Tailscale Serve (recommended) -- gives you an automatic HTTPS URL:
       tailscale serve --bg 3000
     This exposes the app at https://<machine-name>.<tailnet>.ts.net with a
     valid TLS certificate, reachable from any device on your tailnet -- no
     open ports, no reverse proxy needed.

  2. Plain tailnet IP -- reach the app directly at http://<tailscale-ip>:3000
     (find your IP with \`tailscale ip\`). No HTTPS, but still private to your
     tailnet.

This wizard will NOT run these commands for you -- run them yourself when
ready.
`);
      const willUseServe = await askYesNo(
        "Will you use `tailscale serve --bg 3000` for automatic HTTPS?",
        true,
      );
      if (willUseServe) {
        const hostname = await ask(
          "Your machine's ts.net hostname (e.g. myhost.tailnet-name.ts.net) -- optional, press Enter to skip",
        );
        if (hostname) {
          appUrl = `https://${hostname.replace(/^https?:\/\//, "")}`;
        }
      }
    }
  } else if (choice === 3) {
    console.log(`
See the "Reverse proxy + HTTPS" section in docs/install/INSTALL.md. Put any
reverse proxy (nginx, Caddy, Nginx Proxy Manager, Traefik, ...) in front of
ClearSugar with a valid HTTPS certificate before exposing it beyond your LAN.
Never expose ClearSugar to the internet without HTTPS and without auth.
`);
    const domain = await ask(
      "Your public URL (e.g. https://clearsugar.example.com) -- optional, press Enter to skip",
    );
    if (domain) appUrl = domain;
  }

  return { appUrl };
}

// ── .env assembly ────────────────────────────────────────────────────────────

function buildEnvFile(v) {
  const lines = [];
  const p = (s = "") => lines.push(s);

  p(`# ClearSugar Community — generated by \`npm run setup\` on ${new Date().toISOString()}`);
  p("# Do not commit this file.");
  p("");
  p("# ─── Required ───────────────────────────────────────────────────────────────");
  p(`NIGHTSCOUT_URL=${v.nightscoutUrl}`);
  p(`NIGHTSCOUT_API_SECRET=${v.nightscoutApiSecret}`);
  p(`AUTH_SECRET=${v.authSecret}`);
  p(`CLEARSUGAR_API_KEY=${v.clearsugarApiKey}`);
  p(`CLEARSUGAR_DATA_DIR=${v.dataDir}`);
  p("");
  p("# ─── AI insights ────────────────────────────────────────────────────────────");
  p(`LLM_PROVIDER=${v.ai.llmProvider}`);
  p(`ANTHROPIC_API_KEY=${v.ai.anthropicApiKey}`);
  p(`ANTHROPIC_MODEL=${v.ai.anthropicModel}`);
  p(`OLLAMA_URL=${v.ai.ollamaUrl}`);
  p(`OLLAMA_MODEL=${v.ai.ollamaModel}`);
  p(`OPENAI_COMPAT_URL=${v.ai.openaiCompatUrl}`);
  p(`OPENAI_COMPAT_API_KEY=${v.ai.openaiCompatApiKey}`);
  p(`OPENAI_COMPAT_MODEL=${v.ai.openaiCompatModel}`);
  p(`CLAUDE_CLI_PATH=${v.ai.claudeCliPath}`);
  p(`CODEX_CLI_PATH=${v.ai.codexCliPath}`);
  p("");
  p("# ─── Optional integrations ──────────────────────────────────────────────────");
  p(`CLEARSUGAR_PREDICT_URL=`);
  p(`CLEARSUGAR_PREDICT_TOKEN=`);
  p(`TCONNECT_WEBHOOK_URL=${v.tandem.tconnectWebhookUrl}`);
  p(`TCONNECT_WEBHOOK_TOKEN=${v.tandem.tconnectWebhookToken}`);
  p(`MOBILE_JWT_SECRET=${v.mobileJwtSecret}`);
  p(`APNS_KEY_ID=`);
  p(`APNS_TEAM_ID=`);
  p(`APNS_PRIVATE_KEY_B64=`);
  p(`APNS_BUNDLE_ID=`);
  p(`APNS_SANDBOX=true`);
  p(`DEMO_MODE=false`);
  p("");
  p("# ─── Remote access ──────────────────────────────────────────────────────────");
  p(`APP_URL=${v.remote.appUrl}`);
  p("");
  return lines.join("\n");
}

// ── Local data store writes ─────────────────────────────────────────────────
// Must match src/lib/local-store.ts exactly: filePath(key) joins
// CLEARSUGAR_DATA_DIR with the key as a literal relative path -- no extension
// is appended by the store itself. The auth/profile keys are used bare, with
// no ".json" suffix (see src/lib/users-store.ts USERS_KEY = "auth/users" and
// src/lib/patient-profile.ts PROFILE_KEY = "profile/patient", matching
// AGENTS.md's contract naming exactly).

async function writeDataStoreFile(dataDir, relKey, data) {
  const fp = path.join(dataDir, relKey);
  await mkdir(path.dirname(fp), { recursive: true });
  await writeFile(fp, JSON.stringify(data, null, 2));
  return fp;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await stepDisclaimer();

  const ns = await stepNightscout();
  const tandem = await stepTandem(ns);

  if (ns.generateCompose) {
    const yaml = buildComposeYaml({
      apiSecret: ns.composeApiSecret,
      bridgeUser: ns.bridgeUser,
      bridgePassword: ns.bridgePassword,
      includeTconnect: tandem.includeTconnectInCompose,
      tconnect: tandem.tconnect,
    });
    await mkdir(path.dirname(COMPOSE_PATH), { recursive: true });
    await writeFile(COMPOSE_PATH, yaml);
    console.log(`\nWrote ${path.relative(REPO_ROOT, COMPOSE_PATH)}`);
    console.log(
      "  NOTE: this file now contains a generated secret. Avoid committing it with " +
        "real values if you publish changes to a fork of this repo.",
    );
  }

  console.log("\n--- Data directory ---");
  const dataDir = await ask("Local data directory for ClearSugar's JSON storage", {
    defaultValue: "./.data",
  });

  const profile = await stepProfile();
  const admin = await stepAdmin();
  const ai = await stepAiInsights();
  const remote = await stepRemoteAccess();

  console.log("\n--- Generating secrets ---");
  const authSecret = genSecret(32);
  const clearsugarApiKey = genSecret(32);
  const mobileJwtSecret = genSecret(32);
  console.log("  AUTH_SECRET, CLEARSUGAR_API_KEY, MOBILE_JWT_SECRET generated.");

  // Write patient profile + admin user to the local data store. Keys match
  // src/lib/patient-profile.ts PROFILE_KEY and src/lib/users-store.ts
  // USERS_KEY exactly -- no ".json" suffix.
  const profilePath = await writeDataStoreFile(dataDir, "profile/patient", profile);
  const usersPath = await writeDataStoreFile(dataDir, "auth/users", {
    users: [admin],
  });
  console.log(`\nWrote ${profilePath}`);
  console.log(`Wrote ${usersPath}`);

  const envContent = buildEnvFile({
    nightscoutUrl: ns.nightscoutUrl,
    nightscoutApiSecret: ns.nightscoutApiSecret,
    authSecret,
    clearsugarApiKey,
    dataDir,
    ai,
    tandem,
    mobileJwtSecret,
    remote,
  });

  if (existsSync(ENV_PATH)) {
    const overwrite = await askYesNo("\n.env already exists. Back it up and overwrite?", true);
    if (!overwrite) {
      console.log("Setup cancelled -- .env left unchanged.");
      rl.close();
      process.exit(0);
    }
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${ENV_PATH}.backup-${ts}`;
    await rename(ENV_PATH, backupPath);
    console.log(`  Backed up existing .env to ${path.basename(backupPath)}`);
  }

  await writeFile(ENV_PATH, envContent);
  if (process.platform !== "win32") {
    await chmod(ENV_PATH, 0o600);
  }
  console.log(`\nWrote ${path.relative(REPO_ROOT, ENV_PATH)}`);

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n======================================================================");
  console.log(" Setup complete");
  console.log("======================================================================");
  console.log("\nNext steps:");
  let step = 1;
  if (ns.generateCompose) {
    console.log(`  ${step++}. Start Nightscout: cd docker && docker compose up -d`);
  }
  console.log(`  ${step++}. Build the app: npm run build`);
  console.log(`  ${step++}. Start the app: npm start`);
  console.log(
    `  ${step++}. For a persistent install, see docs/install/INSTALL.md for the systemd unit ` +
      "and reverse-proxy/HTTPS notes.",
  );
  if (remote.appUrl) {
    console.log(`\nAPP_URL set to ${remote.appUrl}.`);
  }
  console.log(
    "\nReminder: ClearSugar is not a medical device. Keep your CGM/pump's own alarms active.\n",
  );

  rl.close();
}

main().catch((err) => {
  console.error("\nSetup failed:", err);
  rl.close();
  process.exit(1);
});
