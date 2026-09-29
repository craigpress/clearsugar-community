import { loadJSON } from "@/lib/local-store";
import { getPatientProfile } from "@/lib/patient-profile";

export interface MealProfile { id: string; name: string; isTest: boolean; members: string[] }
export const PROFILES_KEY = "profile/meals";
export const PROFILE_ID = /^[a-z][a-z0-9-]{0,39}$/;
export async function loadMealProfiles(): Promise<MealProfile[]> {
  const saved = await loadJSON<MealProfile[] | null>(PROFILES_KEY, null);
  if (saved) return saved;
  const patient = await getPatientProfile();
  return [{ id: "patient", name: patient.name || "Primary profile", isTest: false, members: [] }];
}
export function accessibleProfiles(profiles: MealProfile[], user: { sub: string; role: string }) {
  if (user.role === "owner") return profiles;
  if (user.role !== "parent" && user.role !== "child") return [];
  return profiles.filter(p => p.members.some(name => name.toLowerCase() === user.sub.toLowerCase()));
}
