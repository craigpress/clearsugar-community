import { NextResponse } from "next/server";
import { loadJSON, saveJSON } from "@/lib/local-store";
import { requireApiAuth, getAuthIdentity } from "@/lib/api-auth";


const PREFS_KEY = "push/alert-preferences.json";

/**
 * Who a device belongs to. `role` drives delivery routing, not `owner` — a
 * free-text label is for humans, the role is what code branches on.
 *
 * "parent" is the consent-bearing tier: high-side pen-correction advice is a
 * caregiver DOSING decision and goes only to these. "patient" is the patient's own
 * phone — it gets everything except insulin-dosing advice. "unassigned" is the
 * safe default for a device nobody has labeled yet, and deliberately receives
 * no high-side advice.
 */
export type DeviceRole = "parent" | "patient" | "unassigned";

export interface DeviceAlertPrefs {
  device: string;  // iOS-reported model name — always "iPhone" since iOS 16, so useless for identification
  /** Human label set from the website (e.g. a caregiver's name). Display only. */
  owner?: string;
  /** Routing tier. Defaults to "unassigned" — never assume a new device is a parent's. */
  role?: DeviceRole;
  /** Auth subject of whoever registered this device. Set from the
   *  Bearer JWT at registration. This is what makes an assignment survive an
   *  APNs token rotation: the new token arrives with the same sub and inherits
   *  the identity's role. Absent on devices registered before identity-keying shipped. */
  sub?: string;
  thresholdUrgentLow: number;
  thresholdLow: number;
  thresholdHigh: number;
  thresholdUrgentHigh: number;
  /** True when the thresholds were last edited from the website. */
  webEdited?: boolean;
  /** The values the iOS app last reported, verbatim. Lets a launch-time
   *  re-post (identical values) be told apart from a real phone-side edit,
   *  so the app relaunching doesn't clobber a website edit. */
  iosReported?: {
    thresholdUrgentLow: number;
    thresholdLow: number;
    thresholdHigh: number;
    thresholdUrgentHigh: number;
  };
}

const DEFAULT_PREFS = {
  thresholdUrgentLow: 55,
  thresholdLow: 70,
  thresholdHigh: 180,
  thresholdUrgentHigh: 250,
};

type Thresholds = typeof DEFAULT_PREFS;

// Maps APNs token → prefs (token is stable unique key; device name is display only)
type PrefsMap = Record<string, DeviceAlertPrefs>;

export async function loadAlertPrefs(): Promise<PrefsMap> {
  return loadJSON<PrefsMap>(PREFS_KEY, {});
}

async function saveAlertPrefs(prefs: PrefsMap): Promise<void> {
  await saveJSON(PREFS_KEY, prefs);
}

/** Returns prefs for a token, falling back to defaults for missing fields */
export function getDevicePrefs(prefs: PrefsMap, token: string): DeviceAlertPrefs {
  const p = prefs[token];
  return {
    device: p?.device ?? "unknown",
    owner: p?.owner,
    role: p?.role ?? "unassigned",
    thresholdUrgentLow: typeof p?.thresholdUrgentLow === "number" ? p.thresholdUrgentLow : DEFAULT_PREFS.thresholdUrgentLow,
    thresholdLow: typeof p?.thresholdLow === "number" ? p.thresholdLow : DEFAULT_PREFS.thresholdLow,
    thresholdHigh: typeof p?.thresholdHigh === "number" ? p.thresholdHigh : DEFAULT_PREFS.thresholdHigh,
    thresholdUrgentHigh: typeof p?.thresholdUrgentHigh === "number" ? p.thresholdUrgentHigh : DEFAULT_PREFS.thresholdUrgentHigh,
  };
}

/** Durable per-person assignment, keyed by auth subject. Survives everything
 *  a device-side identifier does not: token rotation, reinstall, new phone. */
export interface Identity {
  owner?: string;
  role: DeviceRole;
}
type IdentityMap = Record<string, Identity>;
const IDENTITIES_KEY = "push/identities.json";

export async function loadIdentities(): Promise<IdentityMap> {
  return loadJSON<IdentityMap>(IDENTITIES_KEY, {});
}

async function saveIdentities(m: IdentityMap): Promise<void> {
  await saveJSON(IDENTITIES_KEY, m);
}

/** A device's effective role: the person's assignment if the device registered
 *  with a known identity, else the per-device role set before identity-keying. */
export function effectiveRole(p: DeviceAlertPrefs, identities: IdentityMap): DeviceRole {
  if (p.sub && identities[p.sub]) return identities[p.sub].role;
  return p.role ?? "unassigned";
}

/**
 * Tokens belonging to caregivers — the recipients for high-side insulin advice.
 *
 * Derived from role rather than a hand-maintained token list, because APNs
 * tokens rotate on every TestFlight upgrade: on 2026-07-18 an upgrade
 * invalidated both tokens in push/high-alert-recipients.json and insulin advice
 * silently reached nobody for ~19h. Resolving through the auth subject means
 * the replacement token inherits the person's role on its first registration,
 * with no manual re-assignment step to forget.
 *
 * Returns [] when nothing is assigned, which callers must treat as "do not
 * deliver" rather than "deliver to everyone".
 */
export function parentTokens(prefs: PrefsMap, identities: IdentityMap = {}): string[] {
  return tokensWithRole(prefs, identities, "parent");
}

/** Tokens belonging to the patient. Separate from parents because the two are
 *  not interchangeable everywhere — only high-side delivery currently unions
 *  them. */
export function patientTokens(prefs: PrefsMap, identities: IdentityMap = {}): string[] {
  return tokensWithRole(prefs, identities, "patient");
}

function tokensWithRole(prefs: PrefsMap, identities: IdentityMap, role: DeviceRole): string[] {
  return Object.entries(prefs)
    .filter(([, p]) => effectiveRole(p, identities) === role)
    .map(([token]) => token);
}

function bodyThresholds(body: Record<string, unknown>): Thresholds {
  return {
    thresholdUrgentLow: typeof body.thresholdUrgentLow === "number" ? body.thresholdUrgentLow : DEFAULT_PREFS.thresholdUrgentLow,
    thresholdLow: typeof body.thresholdLow === "number" ? body.thresholdLow : DEFAULT_PREFS.thresholdLow,
    thresholdHigh: typeof body.thresholdHigh === "number" ? body.thresholdHigh : DEFAULT_PREFS.thresholdHigh,
    thresholdUrgentHigh: typeof body.thresholdUrgentHigh === "number" ? body.thresholdUrgentHigh : DEFAULT_PREFS.thresholdUrgentHigh,
  };
}

function sameThresholds(a: Thresholds | undefined, b: Thresholds): boolean {
  return (
    !!a &&
    a.thresholdUrgentLow === b.thresholdUrgentLow &&
    a.thresholdLow === b.thresholdLow &&
    a.thresholdHigh === b.thresholdHigh &&
    a.thresholdUrgentHigh === b.thresholdUrgentHigh
  );
}

/** Clamp web-supplied thresholds to sane clinical bounds and enforce ordering. */
function validateThresholds(t: Thresholds): string | null {
  if (t.thresholdUrgentLow < 40 || t.thresholdUrgentLow > 80) return "Urgent low must be 40–80";
  if (t.thresholdLow < 55 || t.thresholdLow > 100) return "Low must be 55–100";
  if (t.thresholdHigh < 120 || t.thresholdHigh > 300) return "High must be 120–300";
  if (t.thresholdUrgentHigh < 180 || t.thresholdUrgentHigh > 400) return "Urgent high must be 180–400";
  if (!(t.thresholdUrgentLow < t.thresholdLow && t.thresholdLow < t.thresholdHigh && t.thresholdHigh < t.thresholdUrgentHigh)) {
    return "Thresholds must be ordered: urgent low < low < high < urgent high";
  }
  return null;
}

/**
 * POST /api/alerts/preferences — iOS app path (full token).
 *
 * Called by the iOS app on launch and when its settings change. A launch-time
 * re-post carries the SAME values the app last reported; when a newer website
 * edit exists (webEdited), such a no-change re-post must NOT overwrite it.
 * Only a genuinely NEW value from the phone (user edited on the phone) wins.
 */
export async function POST(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  try {
    const body = await req.json();
    const token = (body.token || "").trim();
    const device = (body.device || "unknown").trim();
    if (!token) {
      return NextResponse.json({ error: "token required" }, { status: 400 });
    }

    const prefs = await loadAlertPrefs();
    const existing = prefs[token];
    const incoming = bodyThresholds(body);

    const isLaunchRepost =
      existing?.webEdited && sameThresholds(existing.iosReported, incoming);

    // Attribute the device to whoever's JWT registered it . A token
    // that rotates on a TestFlight upgrade re-registers with the same sub and
    // inherits that person's role — no manual re-assignment.
    const identity = await getAuthIdentity(req);
    const sub = identity?.sub ?? existing?.sub;

    // owner/role are website-owned and MUST survive an iOS re-post — the phone
    // has no idea who it belongs to, and silently dropping the assignment here
    // would un-route high-side alerts on the next app launch.
    prefs[token] = isLaunchRepost
      ? { ...existing, device, sub, iosReported: incoming } // keep the web-edited values
      : {
          device,
          owner: existing?.owner,
          role: existing?.role ?? "unassigned",
          sub,
          ...incoming,
          webEdited: false,
          iosReported: incoming,
        };
    await saveAlertPrefs(prefs);

    return NextResponse.json({
      saved: true,
      device,
      token: token.substring(0, 8) + "...",
      keptWebEdit: !!isLaunchRepost,
      prefs: prefs[token],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * PATCH /api/alerts/preferences — website path.
 *
 * Body: { tokenSuffix: string, thresholdUrgentLow, thresholdLow, thresholdHigh, thresholdUrgentHigh }
 * The browser never holds full APNs tokens — it identifies a device by the
 * 6-char suffix shown in the alerts panel; matching happens server-side.
 */
export async function PATCH(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  try {
    const body = await req.json();
    const suffix = (body.tokenSuffix || "").trim();
    if (!suffix || suffix.length < 4) {
      return NextResponse.json({ error: "tokenSuffix required" }, { status: 400 });
    }

    const prefs = await loadAlertPrefs();
    const matches = Object.keys(prefs).filter((t) => t.endsWith(suffix));
    if (matches.length !== 1) {
      return NextResponse.json(
        { error: matches.length === 0 ? "No device matches that suffix" : "Suffix is ambiguous" },
        { status: 404 }
      );
    }

    const token = matches[0];

    // Assignment-only PATCH: {tokenSuffix, owner?, role?} with no threshold
    // fields. Kept separate from the threshold path so labelling a phone can
    // never trip clinical-bound validation, and so a threshold edit can't
    // silently reassign a device.
    const hasThresholds = ["thresholdUrgentLow", "thresholdLow", "thresholdHigh", "thresholdUrgentHigh"]
      .some((k) => typeof body[k] === "number");
    const hasAssignment = typeof body.owner === "string" || typeof body.role === "string";

    if (!hasThresholds && !hasAssignment) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }

    if (hasAssignment) {
      const identity = await getAuthIdentity(req);
      if (identity?.role !== "owner") {
        return NextResponse.json({ error: "Owner role required to assign devices" }, { status: 403 });
      }
      if (typeof body.role === "string" && !["parent", "patient", "unassigned"].includes(body.role)) {
        return NextResponse.json(
          { error: 'role must be "parent", "patient", or "unassigned"' },
          { status: 400 }
        );
      }
      prefs[token] = {
        ...prefs[token],
        ...(typeof body.owner === "string" ? { owner: body.owner.trim() } : {}),
        ...(typeof body.role === "string" ? { role: body.role as DeviceRole } : {}),
      };

      // Mirror onto the person, so the assignment outlives this token. Without
      // this the whole CS-027 chain is inert: the device would carry a sub but
      // nothing would map that sub to a role for the next token to inherit.
      const sub = prefs[token].sub;
      if (sub) {
        const identities = await loadIdentities();
        identities[sub] = {
          owner: prefs[token].owner ?? identities[sub]?.owner,
          role: prefs[token].role ?? identities[sub]?.role ?? "unassigned",
        };
        await saveIdentities(identities);
      }
    }

    if (hasThresholds) {
      const incoming = bodyThresholds(body);
      const invalid = validateThresholds(incoming);
      if (invalid) {
        return NextResponse.json({ error: invalid }, { status: 400 });
      }
      prefs[token] = { ...prefs[token], ...incoming, webEdited: true };
    }

    await saveAlertPrefs(prefs);

    return NextResponse.json({ saved: true, device: prefs[token].device, prefs: prefs[token] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** GET /api/alerts/preferences — list all device preferences (token suffixes only) */
export async function GET(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  const prefs = await loadAlertPrefs();
  const devices = Object.entries(prefs).map(([token, p]) => ({
    tokenSuffix: token.slice(-6),
    device: p.device,
    owner: p.owner ?? null,
    role: p.role ?? "unassigned",
    webEdited: !!p.webEdited,
    thresholds: {
      urgentLow: p.thresholdUrgentLow ?? DEFAULT_PREFS.thresholdUrgentLow,
      low: p.thresholdLow ?? DEFAULT_PREFS.thresholdLow,
      high: p.thresholdHigh ?? DEFAULT_PREFS.thresholdHigh,
      urgentHigh: p.thresholdUrgentHigh ?? DEFAULT_PREFS.thresholdUrgentHigh,
    },
  }));
  return NextResponse.json({ devices, defaults: DEFAULT_PREFS });
}
