/**
 * ClearSugar — Patient profile
 *
 * Runtime-configurable patient identity, persisted at `profile/patient` via
 * the local JSON store (see AGENTS.md). All UI copy and LLM prompts must read
 * patient identity through this module rather than hardcoding a name.
 */

import { loadJSON, saveJSON } from "./local-store";

export interface PatientProfile {
  name: string;
  ageYears: number | null;
  cgm: string;
  pump: string;
  insulinNotes: string;
  clinicalNotes: string;
}

const PROFILE_KEY = "profile/patient";
const CACHE_MS = 60_000;

const EMPTY_PROFILE: PatientProfile = {
  name: "",
  ageYears: null,
  cgm: "",
  pump: "",
  insulinNotes: "",
  clinicalNotes: "",
};

let cached: { profile: PatientProfile; loadedAt: number } | null = null;

/** Read the patient profile, cached in-memory for ~60s. */
export async function getPatientProfile(): Promise<PatientProfile> {
  if (cached && Date.now() - cached.loadedAt < CACHE_MS) {
    return cached.profile;
  }
  const profile = await loadJSON<PatientProfile>(PROFILE_KEY, EMPTY_PROFILE);
  cached = { profile, loadedAt: Date.now() };
  return profile;
}

/** Persist the patient profile and refresh the in-memory cache. */
export async function savePatientProfile(profile: PatientProfile): Promise<void> {
  await saveJSON(PROFILE_KEY, profile);
  cached = { profile, loadedAt: Date.now() };
}

/**
 * Build a one-line bio string for LLM prompts and UI headers, e.g.
 * "Jordan, 17-year-old with Type 1 Diabetes, Tandem t:slim X2 + Control-IQ
 * pump, Dexcom G7 CGM. Notes: takes growth hormone at night."
 *
 * Falls back to the neutral phrase "the patient" when no profile is set,
 * and omits any field that is empty.
 */
export function describePatient(profile: PatientProfile | null | undefined): string {
  const name = profile?.name?.trim() || "the patient";
  const age = profile?.ageYears;
  const ageStr = typeof age === "number" && age > 0 ? `${age}-year-old with ` : "";

  const parts: string[] = [`${name}, ${ageStr}Type 1 Diabetes`];

  const devices: string[] = [];
  if (profile?.pump?.trim()) devices.push(`${profile.pump.trim()} pump`);
  if (profile?.cgm?.trim()) devices.push(`${profile.cgm.trim()} CGM`);
  if (devices.length > 0) parts.push(devices.join(", "));

  let bio = parts.join(", ");

  const notes: string[] = [];
  if (profile?.insulinNotes?.trim()) notes.push(profile.insulinNotes.trim());
  if (profile?.clinicalNotes?.trim()) notes.push(profile.clinicalNotes.trim());
  if (notes.length > 0) bio += `. Notes: ${notes.join("; ")}`;

  return bio;
}
