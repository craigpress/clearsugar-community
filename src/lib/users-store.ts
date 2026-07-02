/**
 * ClearSugar — Local username/password user store
 *
 * Reads and writes the `auth/users` record via the local filesystem store.
 * Passwords are stored only as bcrypt hashes (cost 12); plaintext passwords
 * and hashes are never logged.
 *
 * This module is the single source of truth for credential verification. It is
 * shared by the web auth (NextAuth Credentials provider), the mobile token
 * route, and the first-run setup wizard (via `createUser`).
 */

import bcrypt from "bcryptjs";
import { loadJSON, saveJSON } from "@/lib/local-store";
import type { UserRole } from "@/lib/roles";

/** Shape of a single record in `auth/users`. */
export interface StoredUser {
  username: string;
  passwordHash: string; // bcrypt
  role: UserRole;
  createdAt: string; // ISO
}

interface UsersFile {
  users: StoredUser[];
}

const USERS_KEY = "auth/users";
const BCRYPT_COST = 12;

/**
 * A valid bcrypt hash used as a constant-work comparison target when a
 * username does not exist. Running a real bcrypt.compare against this keeps the
 * timing profile of "unknown user" indistinguishable from "wrong password",
 * preventing user enumeration. Computed once at module load.
 */
const DUMMY_HASH = bcrypt.hashSync("clearsugar-nonexistent-user", BCRYPT_COST);

/** Return all stored users (empty array if the file is missing/invalid). */
export async function getUsers(): Promise<StoredUser[]> {
  const data = await loadJSON<UsersFile>(USERS_KEY, { users: [] });
  return Array.isArray(data?.users) ? data.users : [];
}

/** Find a user by username (case-insensitive). Returns null if not found. */
export async function findUser(username: string): Promise<StoredUser | null> {
  if (typeof username !== "string" || !username.trim()) return null;
  const target = username.trim().toLowerCase();
  const users = await getUsers();
  return users.find((u) => u.username.toLowerCase() === target) ?? null;
}

/**
 * Verify a username/password pair. Returns the user record on success, null on
 * any failure. Always performs a bcrypt.compare (against a dummy hash for
 * unknown users) so that unknown-user and wrong-password paths are
 * indistinguishable. Fails closed.
 */
export async function verifyPassword(
  username: string,
  password: string
): Promise<StoredUser | null> {
  const user = await findUser(username);
  const hash = user?.passwordHash ?? DUMMY_HASH;
  const ok =
    typeof password === "string" &&
    password.length > 0 &&
    (await bcrypt.compare(password, hash));
  if (!user || !ok) return null;
  return user;
}

/**
 * Create a new user with a bcrypt-hashed password (cost 12) and persist it.
 * Used by the first-run setup wizard. Throws on duplicate username or invalid
 * input. Returns the stored record.
 */
export async function createUser(
  username: string,
  password: string,
  role: UserRole
): Promise<StoredUser> {
  const uname = typeof username === "string" ? username.trim() : "";
  if (!uname) throw new Error("Username is required");
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("Password is required");
  }

  const users = await getUsers();
  if (users.some((u) => u.username.toLowerCase() === uname.toLowerCase())) {
    throw new Error("A user with that username already exists");
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const user: StoredUser = {
    username: uname,
    passwordHash,
    role,
    createdAt: new Date().toISOString(),
  };

  users.push(user);
  await saveJSON(USERS_KEY, { users } satisfies UsersFile);
  return user;
}

// ---------------------------------------------------------------------------
// In-memory login rate limiting (no external deps).
// Max failed attempts per username per rolling window; process-local.
// ---------------------------------------------------------------------------

const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_MAX_FAILURES = 10;
// Bound the map so a flood of distinct bogus usernames can't grow memory
// without limit. When full, expired entries are swept; if still full, the
// oldest entry is evicted (Map preserves insertion order).
const RATE_MAX_ENTRIES = 10_000;

interface AttemptRecord {
  count: number;
  resetAt: number;
}

const failedAttempts = new Map<string, AttemptRecord>();

function evictIfFull(now: number): void {
  if (failedAttempts.size < RATE_MAX_ENTRIES) return;
  for (const [key, rec] of failedAttempts) {
    if (now > rec.resetAt) failedAttempts.delete(key);
  }
  while (failedAttempts.size >= RATE_MAX_ENTRIES) {
    const oldest = failedAttempts.keys().next().value;
    if (oldest === undefined) break;
    failedAttempts.delete(oldest);
  }
}

function rateKey(username: string): string {
  return (username || "").trim().toLowerCase();
}

/** True if the username has exceeded the failed-attempt budget for the window. */
export function isRateLimited(username: string): boolean {
  const rec = failedAttempts.get(rateKey(username));
  if (!rec) return false;
  if (Date.now() > rec.resetAt) {
    failedAttempts.delete(rateKey(username));
    return false;
  }
  return rec.count >= RATE_MAX_FAILURES;
}

/** Record a failed login attempt for the username. */
export function recordFailedAttempt(username: string): void {
  const key = rateKey(username);
  if (!key) return;
  const now = Date.now();
  evictIfFull(now);
  const rec = failedAttempts.get(key);
  if (!rec || now > rec.resetAt) {
    failedAttempts.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
  } else {
    rec.count += 1;
  }
}

/** Clear the failed-attempt counter for a username (call on success). */
export function clearFailedAttempts(username: string): void {
  failedAttempts.delete(rateKey(username));
}
