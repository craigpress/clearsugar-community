/**
 * ClearSugar — meal photo storage
 *
 * Phase 3, section 4c of docs/MEAL_LOGGING_PLAN_2026-09-04.md. A photo is
 * accepted as base64 JSON (no multipart parser on this stack), validated, run
 * through `stripJpegMetadata`, and written to `photos/<id>.jpg` via
 * `local-store.saveBinary`.
 *
 * Two things are stored, not one:
 *   1. the stripped JPEG bytes;
 *   2. a row in the `meals/photos-index.json` sidecar.
 *
 * The sidecar exists because `local-store.listKeys` only lists `.json` files, so
 * the binaries are not enumerable — and because the two jobs that need to reason
 * about photos both need metadata the bytes cannot give them: the 90-day prune
 * (decision 1) needs `createdAt` without opening 90 days of images, and a replay
 * of a `clientId` needs to answer with the *same* `photoId` rather than storing
 * the same plate twice.
 *
 * Photo ids are UUIDs and are validated against a strict character class before
 * ever reaching a path. `local-store.filePath` already rejects `..` and absolute
 * keys; this is the second lock, because the id arrives straight off a URL.
 */

import { randomUUID } from "node:crypto";

import { deleteBinary, loadBinary, loadJSON, saveBinary, saveJSON, withStoreLock } from "./profile-storage";
import { isJpeg, readJpegDimensions, stripJpegMetadata, JpegParseError } from "./jpeg";

/** Decoded size ceiling (section 4c). The client downscales to <= 1024 px. */
export const MAX_PHOTO_BYTES = 1_536_000; // 1.5 MB
/** Photo retention (decision 1). */
export const PHOTO_RETENTION_DAYS = 90;
/** A photo id is a UUID; nothing else may reach a filesystem path. */
export const PHOTO_ID_RE = /^[0-9a-f-]{36}$/;
export const PHOTO_INDEX_KEY = "meals/photos-index.json";
const PHOTO_PREFIX = "photos/";
export const MAX_PHOTO_CLIENT_ID_LEN = 64;

/** One `meals/photos-index.json` row, keyed by photo id. */
export interface PhotoIndexEntry {
  createdAt: number;
  /** When the camera took it, if the client said so. */
  takenAt?: number;
  bytes: number;
  width: number;
  height: number;
  /** Authentik subject that uploaded it. */
  sub: string;
  /** Device-minted idempotency key. */
  clientId: string;
}

export type PhotoIndex = Record<string, PhotoIndexEntry>;

/** Raised for a body we will not store; the route answers 400. */
export class PhotoInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoInvalidError";
  }
}

/** Raised when the decoded image exceeds MAX_PHOTO_BYTES; the route answers 413. */
export class PhotoTooLargeError extends Error {
  constructor(bytes: number) {
    super(`Image is ${bytes} bytes; the limit is ${MAX_PHOTO_BYTES}`);
    this.name = "PhotoTooLargeError";
  }
}

export interface SavePhotoInput {
  clientId: string;
  imageBase64: string;
  /** ISO string or epoch ms. */
  takenAt?: string | number | null;
  sub: string;
}

export interface SavePhotoResult {
  photoId: string;
  bytes: number;
  width: number;
  height: number;
  /** True when a known `clientId` was replayed; the route answers 200, not 201. */
  replayed: boolean;
}

/** Injectable clock and id source, so the tests are deterministic. */
export interface PhotoDeps {
  now?: () => number;
  uuid?: () => string;
}

/** Storage key for a photo's bytes. */
export function photoKey(id: string): string {
  return `${PHOTO_PREFIX}${id}.jpg`;
}

/** True when `id` is safe to interpolate into a storage key. */
export function isValidPhotoId(id: unknown): id is string {
  return typeof id === "string" && PHOTO_ID_RE.test(id);
}

async function loadIndex(): Promise<PhotoIndex> {
  const raw = await loadJSON<PhotoIndex>(PHOTO_INDEX_KEY, {});
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

const BASE64_RE = /^[A-Za-z0-9+/=]+$/;
const DATA_URI_RE = /^data:image\/jpe?g;base64,/i;

/**
 * Decode the base64 payload, refusing anything oversized before allocating.
 *
 * A `data:image/jpeg;base64,` prefix is tolerated because that is what a browser
 * canvas hands back; anything else with a `data:` prefix is rejected rather than
 * guessed at.
 */
function decodeImage(imageBase64: unknown): Buffer {
  if (typeof imageBase64 !== "string" || imageBase64.length === 0) {
    throw new PhotoInvalidError("imageBase64 must be a non-empty base64 string");
  }
  let payload = imageBase64.trim();
  if (payload.startsWith("data:")) {
    if (!DATA_URI_RE.test(payload)) {
      throw new PhotoInvalidError("only a data:image/jpeg;base64 URI is accepted");
    }
    payload = payload.replace(DATA_URI_RE, "");
  }
  payload = payload.replace(/\s+/g, "");
  if (!BASE64_RE.test(payload)) {
    throw new PhotoInvalidError("imageBase64 is not valid base64");
  }

  // 4 base64 chars -> 3 bytes. Reject before Buffer.from allocates, so a 50 MB
  // body cannot be turned into 37 MB of resident memory just to be refused.
  const approxBytes = Math.floor((payload.length / 4) * 3);
  if (approxBytes > MAX_PHOTO_BYTES) throw new PhotoTooLargeError(approxBytes);

  const buf = Buffer.from(payload, "base64");
  if (buf.length === 0) throw new PhotoInvalidError("imageBase64 decoded to no bytes");
  if (buf.length > MAX_PHOTO_BYTES) throw new PhotoTooLargeError(buf.length);
  return buf;
}

/** Resolve the optional `takenAt` to epoch ms, or undefined. */
function readTakenAt(takenAt: SavePhotoInput["takenAt"]): number | undefined {
  if (takenAt === undefined || takenAt === null) return undefined;
  if (typeof takenAt === "number") {
    if (!Number.isFinite(takenAt)) {
      throw new PhotoInvalidError("takenAt must be an ISO 8601 string or epoch ms");
    }
    return takenAt;
  }
  if (typeof takenAt !== "string") {
    throw new PhotoInvalidError("takenAt must be an ISO 8601 string or epoch ms");
  }
  const parsed = Date.parse(takenAt);
  if (Number.isNaN(parsed)) {
    throw new PhotoInvalidError("takenAt must be an ISO 8601 string");
  }
  return parsed;
}

/**
 * Validate, strip and store one meal photo.
 *
 * Ordering: the bytes are written before the index row, so a crash between the
 * two leaves an unreferenced binary (invisible, and swept by the next prune)
 * rather than an index row pointing at nothing (a 500 on GET).
 *
 * @throws PhotoInvalidError  bad base64, not a JPEG, malformed marker stream
 * @throws PhotoTooLargeError decoded image over MAX_PHOTO_BYTES
 */
export async function savePhoto(
  input: SavePhotoInput,
  deps: PhotoDeps = {}
): Promise<SavePhotoResult> {
  return withStoreLock(PHOTO_INDEX_KEY, () => savePhotoUnlocked(input, deps));
}

async function savePhotoUnlocked(
  input: SavePhotoInput,
  deps: PhotoDeps = {}
): Promise<SavePhotoResult> {
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? randomUUID;

  const clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
  if (clientId.length === 0) {
    throw new PhotoInvalidError("clientId must be a non-empty string");
  }
  if (clientId.length > MAX_PHOTO_CLIENT_ID_LEN) {
    throw new PhotoInvalidError(
      `clientId must be at most ${MAX_PHOTO_CLIENT_ID_LEN} characters`
    );
  }
  const sub = typeof input.sub === "string" ? input.sub : "";
  if (sub.length === 0) throw new PhotoInvalidError("sub is required");

  const takenAt = readTakenAt(input.takenAt);

  // Replay before doing any work: the same clientId always answers with the
  // same photoId, so a retried upload never stores the plate twice.
  const index = await loadIndex();
  for (const [id, entry] of Object.entries(index)) {
    if (entry?.clientId === clientId) {
      return {
        photoId: id,
        bytes: entry.bytes,
        width: entry.width,
        height: entry.height,
        replayed: true,
      };
    }
  }

  const decoded = decodeImage(input.imageBase64);
  if (!isJpeg(decoded)) {
    throw new PhotoInvalidError("only JPEG images are accepted (magic FF D8 FF)");
  }

  let stripped: Buffer;
  let width: number;
  let height: number;
  try {
    stripped = stripJpegMetadata(decoded);
    ({ width, height } = readJpegDimensions(stripped));
  } catch (err) {
    if (err instanceof JpegParseError) throw new PhotoInvalidError(err.message);
    throw err;
  }

  const photoId = uuid();
  if (!isValidPhotoId(photoId)) {
    throw new PhotoInvalidError("generated photo id is not a UUID");
  }

  await saveBinary(photoKey(photoId), stripped);

  const entry: PhotoIndexEntry = {
    createdAt: now(),
    ...(takenAt !== undefined && { takenAt }),
    bytes: stripped.length,
    width,
    height,
    sub,
    clientId,
  };
  // Re-read: the index is a read-modify-write, and the strip above took long
  // enough that another upload may have landed.
  const fresh = await loadIndex();
  fresh[photoId] = entry;
  await saveJSON(PHOTO_INDEX_KEY, fresh);

  return { photoId, bytes: stripped.length, width, height, replayed: false };
}

/** The stored (already stripped) bytes, or null for an unknown or unsafe id. */
export async function loadPhoto(id: string): Promise<Buffer | null> {
  if (!isValidPhotoId(id)) return null;
  return loadBinary(photoKey(id));
}

/** The index row for a photo, or null. Used by the GET route for Content-Length. */
export async function getPhotoEntry(id: string): Promise<PhotoIndexEntry | null> {
  if (!isValidPhotoId(id)) return null;
  const index = await loadIndex();
  return index[id] ?? null;
}

/**
 * Delete photos older than `maxAgeDays` (decision 1: 90-day retention).
 *
 * The `MealLog` row, its estimate and its `photoId` all survive — only the image
 * goes. `detect.ts` calls this once a day with the default.
 *
 * Signature is load-bearing: `prunePhotos(90)` is called from the detect tick.
 */
export async function prunePhotos(
  maxAgeDays = PHOTO_RETENTION_DAYS,
  nowMs: number = Date.now()
): Promise<{ deleted: number }> {
  return withStoreLock(PHOTO_INDEX_KEY, () => prunePhotosUnlocked(maxAgeDays, nowMs));
}

async function prunePhotosUnlocked(
  maxAgeDays = PHOTO_RETENTION_DAYS,
  nowMs: number = Date.now()
): Promise<{ deleted: number }> {
  const days = Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays : PHOTO_RETENTION_DAYS;
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;

  const index = await loadIndex();
  const doomed: string[] = [];
  for (const [id, entry] of Object.entries(index)) {
    // A row with no usable createdAt is treated as ancient rather than immortal:
    // an un-prunable photo would defeat the retention decision outright.
    const createdAt = typeof entry?.createdAt === "number" ? entry.createdAt : 0;
    if (createdAt < cutoff) doomed.push(id);
  }
  if (doomed.length === 0) return { deleted: 0 };

  for (const id of doomed) {
    if (isValidPhotoId(id)) await deleteBinary(photoKey(id));
  }
  const fresh = await loadIndex();
  for (const id of doomed) delete fresh[id];
  await saveJSON(PHOTO_INDEX_KEY, fresh);

  return { deleted: doomed.length };
}
