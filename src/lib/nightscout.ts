// ClearSugar — Nightscout API client
// Reads from the Nightscout REST API (NIGHTSCOUT_URL)

import { createHash } from "node:crypto";
import type {
  GlucoseReading,
  Treatment,
  PumpProfile,
  NightscoutStatus,
  PumpState,
} from "./types";
import { isDemoMode, demoFetch } from "./demo-data";

const NIGHTSCOUT_URL = process.env.NIGHTSCOUT_URL;

if (!NIGHTSCOUT_URL && !isDemoMode()) {
  console.warn("NIGHTSCOUT_URL not set — Nightscout API calls will fail");
}
const API_SECRET = process.env.NIGHTSCOUT_API_SECRET || "";
const NIGHTSCOUT_TOKEN = process.env.NIGHTSCOUT_TOKEN || "";

function apiSecretHash(): string | null {
  return API_SECRET ? createHash("sha1").update(API_SECRET).digest("hex") : null;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "ClearSugar/1.0",
  };
  const hash = apiSecretHash();
  if (hash) h["api-secret"] = hash;
  return h;
}

// Module-level TTL memo for non-realtime GETs (entries/treatments/profile).
// Keyed by the full request URL. Realtime/latest fetches pass no TTL and are
// never cached, so the dashboard's live number is always fresh.
const fetchCache = new Map<string, { expires: number; data: unknown }>();

async function fetchNS<T>(
  path: string,
  params?: URLSearchParams,
  cacheTtlMs?: number
): Promise<T> {
  // DEMO_MODE — serve deterministic synthetic data, no network call at all.
  // Intercepting here (below the NIGHTSCOUT_URL check) means every exported
  // function in this module works in demo mode without any per-function change.
  if (isDemoMode()) {
    return demoFetch<T>(path, params);
  }
  if (!NIGHTSCOUT_URL) {
    throw new Error("NIGHTSCOUT_URL not configured");
  }
  const url = new URL(path, NIGHTSCOUT_URL);
  if (params) {
    params.forEach((v, k) => url.searchParams.set(k, v));
  }
  const key = url.toString();

  if (cacheTtlMs && cacheTtlMs > 0) {
    const hit = fetchCache.get(key);
    if (hit && hit.expires > Date.now()) {
      return hit.data as T;
    }
  }

  const res = await fetch(key, {
    headers: headers(),
    next: { revalidate: 0 }, // always fresh
  });
  if (!res.ok) {
    throw new Error(`Nightscout ${path}: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as T;

  if (cacheTtlMs && cacheTtlMs > 0) {
    fetchCache.set(key, { expires: Date.now() + cacheTtlMs, data });
  }
  return data;
}

const NS_CACHE_TTL_MS = 60_000;

/** Fetch recent glucose readings */
export async function getEntries(
  count: number = 288, // 24h of 5-min readings
  maxAge?: number // max age in ms
): Promise<GlucoseReading[]> {
  const params = new URLSearchParams({ count: String(count) });
  if (maxAge) {
    const since = Date.now() - maxAge;
    params.set("find[date][$gte]", String(since));
  }
  return fetchNS<GlucoseReading[]>("/api/v1/entries.json", params, NS_CACHE_TTL_MS);
}

/** Fetch the single most recent glucose reading (realtime — never cached) */
export async function getLatestEntry(): Promise<GlucoseReading | null> {
  const params = new URLSearchParams({ count: "1" });
  const entries = await fetchNS<GlucoseReading[]>("/api/v1/entries.json", params);
  return entries[0] ?? null;
}

/** Fetch treatments (boluses, carbs, temp basals) */
export async function getTreatments(
  count: number = 100,
  maxAge?: number
): Promise<Treatment[]> {
  const params = new URLSearchParams({ count: String(count) });
  if (maxAge) {
    const since = new Date(Date.now() - maxAge).toISOString();
    params.set("find[created_at][$gte]", since);
  }
  return fetchNS<Treatment[]>("/api/v1/treatments.json", params, NS_CACHE_TTL_MS);
}

/** Fetch pump profile docs, newest first (count > 1 returns change history) */
export async function getProfile(count = 10): Promise<PumpProfile[]> {
  const params = new URLSearchParams({ count: String(count) });
  return fetchNS<PumpProfile[]>("/api/v1/profile.json", params, NS_CACHE_TTL_MS);
}

/** Fetch Nightscout status */
export async function getStatus(): Promise<NightscoutStatus> {
  return fetchNS<NightscoutStatus>("/api/v1/status.json");
}

/**
 * Fetch the latest pump-state doc published to Nightscout devicestatus by the
 * pump-state publisher (pump IOB + real Control-IQ settings). Returns
 * null when the job hasn't published yet or the doc is malformed — every caller
 * MUST degrade to profile-derived defaults, never assume this is present.
 */
export async function getPumpState(): Promise<PumpState | null> {
  const params = new URLSearchParams({
    count: "1",
    "find[device]": "clearsugar-pumpstate",
  });
  let docs: PumpState[];
  try {
    docs = await fetchNS<PumpState[]>(
      "/api/v1/devicestatus.json",
      params,
      NS_CACHE_TTL_MS
    );
  } catch {
    return null;
  }
  const d = docs?.[0];
  if (!d || !d.created_at) return null;
  d.mills = new Date(d.created_at).getTime();
  if (d.pump?.iob?.timestamp) {
    d.pump.iob.mills = new Date(d.pump.iob.timestamp).getTime();
  }
  return d;
}

/** Get the timestamp of the most recent treatment from tconnectsync */
export async function getLastPumpUpdate(): Promise<Date | null> {
  const params = new URLSearchParams({
    count: "1",
    "find[enteredBy][$regex]": "tconnectsync",
  });
  const treatments = await fetchNS<Treatment[]>(
    "/api/v1/treatments.json",
    params
  );
  if (treatments.length === 0) return null;
  return new Date(treatments[0].created_at);
}

// getBoluses() and getCarbs() removed — dead code with insufficient limits.
// Treatment fetching is handled by /api/treatments route which queries by type.

export const CLEARSUGAR_ENTERED_BY = "ClearSugar";

export type NewTreatment = Omit<
  Treatment,
  "_id" | "mills" | "utcOffset" | "enteredBy" | "created_at"
> & { created_at?: string };

function applyWriteAuth(url: URL, h: Record<string, string>): void {
  if (NIGHTSCOUT_TOKEN) {
    url.searchParams.set("token", NIGHTSCOUT_TOKEN);
    return;
  }
  const hash = apiSecretHash();
  if (hash) {
    h["api-secret"] = hash;
    return;
  }
  throw new Error("Nightscout write credential not configured");
}

function invalidateTreatmentsCache(): void {
  for (const key of fetchCache.keys()) {
    if (key.includes("/api/v1/treatments")) fetchCache.delete(key);
  }
}

export async function postTreatment(input: NewTreatment): Promise<Treatment> {
  if (isDemoMode()) throw new Error("Nightscout writes are unavailable in demo mode");
  if (!NIGHTSCOUT_URL) throw new Error("NIGHTSCOUT_URL not configured");
  const doc = {
    ...input,
    enteredBy: CLEARSUGAR_ENTERED_BY,
    created_at: input.created_at ?? new Date().toISOString(),
  };
  const url = new URL("/api/v1/treatments.json", NIGHTSCOUT_URL);
  const h: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "ClearSugar/1.0",
  };
  applyWriteAuth(url, h);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: h,
    body: JSON.stringify([doc]),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Nightscout POST treatments: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as Treatment[] | Treatment;
  const created = Array.isArray(body) ? body[0] : body;
  if (!created || typeof created._id !== "string") {
    throw new Error("Nightscout POST treatments: no document returned");
  }
  invalidateTreatmentsCache();
  return created;
}

export async function deleteTreatment(id: string): Promise<void> {
  if (isDemoMode()) throw new Error("Nightscout writes are unavailable in demo mode");
  if (!NIGHTSCOUT_URL) throw new Error("NIGHTSCOUT_URL not configured");
  if (!/^[a-f0-9]{24}$/i.test(id)) {
    throw new Error(`Nightscout DELETE treatment: invalid id ${JSON.stringify(id)}`);
  }
  const url = new URL(`/api/v1/treatments/${id}`, NIGHTSCOUT_URL);
  const h: Record<string, string> = { Accept: "application/json", "User-Agent": "ClearSugar/1.0" };
  applyWriteAuth(url, h);
  const res = await fetch(url.toString(), { method: "DELETE", headers: h, cache: "no-store" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Nightscout DELETE treatment: ${res.status} ${res.statusText}`);
  }
  invalidateTreatmentsCache();
}
