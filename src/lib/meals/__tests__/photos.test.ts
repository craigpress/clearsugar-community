import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `local-store` reads CLEARSUGAR_DATA_DIR at module load, so the env var must be
 * set and the registry reset before `photos.ts` is imported (same discipline as
 * store.test.ts).
 */
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cs-photos-"));
  process.env.CLEARSUGAR_DATA_DIR = dir;
  vi.resetModules();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function loadPhotos() {
  return import("../photos");
}

const NOW = Date.parse("2026-09-04T18:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

// ── fixtures ────────────────────────────────────────────────────────────────

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];

function seg(marker: number, payload: number[]): number[] {
  const len = payload.length + 2;
  return [0xff, marker, (len >> 8) & 0xff, len & 0xff, ...payload];
}
function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}
const APP1_EXIF = seg(0xe1, [...ascii("Exif"), 0, 0, ...ascii("GPS 39.95,-75.19")]);
const DQT = seg(0xdb, [0x00, ...new Array(64).fill(0x10)]);
const SOS = [...seg(0xda, [1, 1, 0, 0, 0x3f, 0]), 0x12, 0x34, 0xff, 0x00];

function sof(width: number, height: number): number[] {
  return seg(0xc0, [
    8,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    1,
    1,
    0x11,
    0,
  ]);
}

/**
 * A JPEG with EXIF, plus optional padding to reach a given size.
 *
 * Padding is spread over several DQT segments because a JPEG segment length is
 * 16 bits — one 1.5 MB segment is not a legal stream, so a "too large" fixture
 * built that way would fail as malformed and never exercise the size check.
 */
function jpegFixture(width = 1024, height = 768, padBytes = 0): Buffer {
  const pad: number[] = [];
  let left = padBytes;
  while (left > 0) {
    const chunk = Math.min(left, 60_000);
    pad.push(...seg(0xdb, [0x01, ...new Array(chunk).fill(0x20)]));
    left -= chunk;
  }
  return Buffer.from([...SOI, ...APP1_EXIF, ...DQT, ...pad, ...sof(width, height), ...SOS, ...EOI]);
}

function b64(buf: Buffer): string {
  return buf.toString("base64");
}

const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function fixedDeps(ids: string[], now = NOW) {
  let i = 0;
  return { now: () => now, uuid: () => ids[i++] ?? `overflow-${i}` };
}

async function readIndex(): Promise<Record<string, Record<string, unknown>>> {
  return JSON.parse(await readFile(join(dir, "meals", "photos-index.json"), "utf-8"));
}

it("serializes concurrent uploads and replays without losing photo index entries", async () => {
  const photos = await loadPhotos();
  const deps = fixedDeps([UUID_A, UUID_B]);
  const first = { clientId: "same", imageBase64: b64(jpegFixture()), sub: "patient" };
  const results = await Promise.all([
    photos.savePhoto(first, deps), photos.savePhoto(first, deps),
    photos.savePhoto({ ...first, clientId: "different" }, deps),
  ]);
  expect(results[0].photoId).toBe(results[1].photoId);
  expect(Object.keys(await readIndex())).toHaveLength(2);
});

// ── savePhoto ───────────────────────────────────────────────────────────────

describe("savePhoto — happy path", () => {
  it("stores the stripped bytes and returns the id, size and dimensions", async () => {
    const { savePhoto, photoKey } = await loadPhotos();
    const original = jpegFixture(1024, 768);

    const result = await savePhoto(
      { clientId: "cid-1", imageBase64: b64(original), sub: "patient" },
      fixedDeps([UUID_A])
    );

    expect(result).toEqual({
      photoId: UUID_A,
      bytes: original.length - APP1_EXIF.length,
      width: 1024,
      height: 768,
      replayed: false,
    });
    const onDisk = await readFile(join(dir, photoKey(UUID_A)));
    expect(onDisk.length).toBe(result.bytes);
  });

  it("removes the EXIF before anything touches the filesystem", async () => {
    const { savePhoto, photoKey } = await loadPhotos();
    await savePhoto(
      { clientId: "cid-1", imageBase64: b64(jpegFixture()), sub: "patient" },
      fixedDeps([UUID_A])
    );
    const onDisk = await readFile(join(dir, photoKey(UUID_A)));
    expect(onDisk.includes(Buffer.from("GPS 39.95,-75.19"))).toBe(false);
    expect(onDisk.includes(Buffer.from("Exif"))).toBe(false);
  });

  it("writes the sidecar index row", async () => {
    const { savePhoto, PHOTO_INDEX_KEY } = await loadPhotos();
    expect(PHOTO_INDEX_KEY).toBe("meals/photos-index.json");
    await savePhoto(
      {
        clientId: "cid-1",
        imageBase64: b64(jpegFixture(640, 480)),
        takenAt: "2026-09-04T17:45:00.000Z",
        sub: "patient",
      },
      fixedDeps([UUID_A])
    );
    const index = await readIndex();
    expect(index[UUID_A]).toEqual({
      createdAt: NOW,
      takenAt: Date.parse("2026-09-04T17:45:00.000Z"),
      bytes: expect.any(Number),
      width: 640,
      height: 480,
      sub: "patient",
      clientId: "cid-1",
    });
  });

  it("omits takenAt when the client did not send one", async () => {
    const { savePhoto } = await loadPhotos();
    await savePhoto(
      { clientId: "cid-1", imageBase64: b64(jpegFixture()), sub: "patient" },
      fixedDeps([UUID_A])
    );
    expect("takenAt" in (await readIndex())[UUID_A]).toBe(false);
  });

  it("accepts epoch-ms takenAt as well as ISO", async () => {
    const { savePhoto } = await loadPhotos();
    await savePhoto(
      { clientId: "cid-1", imageBase64: b64(jpegFixture()), takenAt: NOW - 60_000, sub: "patient" },
      fixedDeps([UUID_A])
    );
    expect((await readIndex())[UUID_A].takenAt).toBe(NOW - 60_000);
  });

  it("tolerates a data:image/jpeg;base64 prefix and embedded whitespace", async () => {
    const { savePhoto } = await loadPhotos();
    const payload = b64(jpegFixture()).replace(/(.{40})/g, "$1\n");
    const result = await savePhoto(
      { clientId: "cid-1", imageBase64: `data:image/jpeg;base64,${payload}`, sub: "patient" },
      fixedDeps([UUID_A])
    );
    expect(result.replayed).toBe(false);
    expect(result.width).toBe(1024);
  });

  it("keeps two different photos apart", async () => {
    const { savePhoto } = await loadPhotos();
    await savePhoto(
      { clientId: "cid-1", imageBase64: b64(jpegFixture(100, 100)), sub: "patient" },
      fixedDeps([UUID_A])
    );
    await savePhoto(
      { clientId: "cid-2", imageBase64: b64(jpegFixture(200, 200)), sub: "patient" },
      fixedDeps([UUID_B])
    );
    const index = await readIndex();
    expect(Object.keys(index).sort()).toEqual([UUID_A, UUID_B].sort());
    expect(index[UUID_B].width).toBe(200);
  });
});

describe("savePhoto — replay", () => {
  it("returns the first photoId for a repeated clientId and stores nothing new", async () => {
    const { savePhoto } = await loadPhotos();
    const first = await savePhoto(
      { clientId: "cid-1", imageBase64: b64(jpegFixture(300, 300)), sub: "patient" },
      fixedDeps([UUID_A])
    );
    const again = await savePhoto(
      { clientId: "cid-1", imageBase64: b64(jpegFixture(999, 999)), sub: "patient" },
      fixedDeps([UUID_B])
    );

    expect(again).toEqual({ ...first, replayed: true });
    expect(again.width).toBe(300); // the retry body is ignored; the key is the clientId
    expect(await readdir(join(dir, "photos"))).toHaveLength(1);
  });

  it("does not even decode the body on a replay", async () => {
    const { savePhoto } = await loadPhotos();
    await savePhoto(
      { clientId: "cid-1", imageBase64: b64(jpegFixture()), sub: "patient" },
      fixedDeps([UUID_A])
    );
    // Garbage that would be a 400 on a first attempt.
    const again = await savePhoto(
      { clientId: "cid-1", imageBase64: "!!!not base64!!!", sub: "patient" },
      fixedDeps([UUID_B])
    );
    expect(again.replayed).toBe(true);
  });
});

describe("savePhoto — rejection", () => {
  it("rejects a non-JPEG", async () => {
    const { savePhoto, PhotoInvalidError } = await loadPhotos();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await expect(
      savePhoto({ clientId: "cid-1", imageBase64: b64(png), sub: "patient" }, fixedDeps([UUID_A]))
    ).rejects.toBeInstanceOf(PhotoInvalidError);
  });

  it("rejects bad base64, an empty payload and a non-string", async () => {
    const { savePhoto, PhotoInvalidError } = await loadPhotos();
    for (const bad of ["", "not base64!!", "***", 42 as unknown as string]) {
      await expect(
        savePhoto({ clientId: "cid-1", imageBase64: bad, sub: "patient" }, fixedDeps([UUID_A]))
      ).rejects.toBeInstanceOf(PhotoInvalidError);
    }
  });

  it("rejects a non-JPEG data URI", async () => {
    const { savePhoto, PhotoInvalidError } = await loadPhotos();
    await expect(
      savePhoto(
        { clientId: "cid-1", imageBase64: `data:image/png;base64,${b64(jpegFixture())}`, sub: "patient" },
        fixedDeps([UUID_A])
      )
    ).rejects.toBeInstanceOf(PhotoInvalidError);
  });

  it("rejects a JPEG with a malformed marker stream", async () => {
    const { savePhoto, PhotoInvalidError } = await loadPhotos();
    // Valid magic, then an APP1 claiming far more bytes than exist.
    const broken = Buffer.from([...SOI, 0xff, 0xe1, 0x7f, 0xff, 1, 2, 3]);
    await expect(
      savePhoto({ clientId: "cid-1", imageBase64: b64(broken), sub: "patient" }, fixedDeps([UUID_A]))
    ).rejects.toBeInstanceOf(PhotoInvalidError);
  });

  it("rejects a JPEG with no SOF (no dimensions to record)", async () => {
    const { savePhoto, PhotoInvalidError } = await loadPhotos();
    const noSof = Buffer.from([...SOI, ...DQT, ...SOS, ...EOI]);
    await expect(
      savePhoto({ clientId: "cid-1", imageBase64: b64(noSof), sub: "patient" }, fixedDeps([UUID_A]))
    ).rejects.toBeInstanceOf(PhotoInvalidError);
  });

  it("rejects an image over 1.5 MB with PhotoTooLargeError", async () => {
    const { savePhoto, PhotoTooLargeError, MAX_PHOTO_BYTES } = await loadPhotos();
    expect(MAX_PHOTO_BYTES).toBe(1_536_000);
    const big = jpegFixture(1024, 768, MAX_PHOTO_BYTES + 1000);
    expect(big.length).toBeGreaterThan(MAX_PHOTO_BYTES);
    await expect(
      savePhoto({ clientId: "cid-1", imageBase64: b64(big), sub: "patient" }, fixedDeps([UUID_A]))
    ).rejects.toBeInstanceOf(PhotoTooLargeError);
  });

  it("accepts an image just under the limit", async () => {
    const { savePhoto, MAX_PHOTO_BYTES } = await loadPhotos();
    const nearLimit = jpegFixture(1024, 768, MAX_PHOTO_BYTES - 5000);
    expect(nearLimit.length).toBeLessThan(MAX_PHOTO_BYTES);
    const result = await savePhoto(
      { clientId: "cid-1", imageBase64: b64(nearLimit), sub: "patient" },
      fixedDeps([UUID_A])
    );
    expect(result.replayed).toBe(false);
  });

  it("rejects a missing clientId or sub", async () => {
    const { savePhoto, PhotoInvalidError } = await loadPhotos();
    const img = b64(jpegFixture());
    await expect(
      savePhoto({ clientId: "  ", imageBase64: img, sub: "patient" }, fixedDeps([UUID_A]))
    ).rejects.toBeInstanceOf(PhotoInvalidError);
    await expect(
      savePhoto({ clientId: "cid-1", imageBase64: img, sub: "" }, fixedDeps([UUID_A]))
    ).rejects.toBeInstanceOf(PhotoInvalidError);
  });

  it("rejects an over-long clientId", async () => {
    const { savePhoto, PhotoInvalidError, MAX_PHOTO_CLIENT_ID_LEN } = await loadPhotos();
    await expect(
      savePhoto(
        {
          clientId: "x".repeat(MAX_PHOTO_CLIENT_ID_LEN + 1),
          imageBase64: b64(jpegFixture()),
          sub: "patient",
        },
        fixedDeps([UUID_A])
      )
    ).rejects.toBeInstanceOf(PhotoInvalidError);
  });

  it("rejects an unparseable takenAt", async () => {
    const { savePhoto, PhotoInvalidError } = await loadPhotos();
    await expect(
      savePhoto(
        { clientId: "cid-1", imageBase64: b64(jpegFixture()), takenAt: "lunchtime", sub: "patient" },
        fixedDeps([UUID_A])
      )
    ).rejects.toBeInstanceOf(PhotoInvalidError);
  });

  it("writes nothing at all when the body is rejected", async () => {
    const { savePhoto } = await loadPhotos();
    await expect(
      savePhoto({ clientId: "cid-1", imageBase64: "***", sub: "patient" }, fixedDeps([UUID_A]))
    ).rejects.toThrow();
    await expect(readdir(join(dir, "photos"))).rejects.toThrow();
  });
});

// ── loadPhoto / isValidPhotoId ──────────────────────────────────────────────

describe("loadPhoto", () => {
  it("round-trips the stored bytes", async () => {
    const { savePhoto, loadPhoto, photoKey } = await loadPhotos();
    await savePhoto(
      { clientId: "cid-1", imageBase64: b64(jpegFixture()), sub: "patient" },
      fixedDeps([UUID_A])
    );
    const bytes = await loadPhoto(UUID_A);
    expect(bytes).toEqual(await readFile(join(dir, photoKey(UUID_A))));
  });

  it("returns null for an unknown id", async () => {
    const { loadPhoto } = await loadPhotos();
    expect(await loadPhoto(UUID_B)).toBeNull();
  });

  it("returns null for anything that is not a UUID — including traversal", async () => {
    const { loadPhoto } = await loadPhotos();
    for (const bad of [
      "../../../etc/passwd",
      "..%2f..%2fsecret",
      "photos/../../push/identities",
      "ABCDEFAB-1111-4111-8111-111111111111", // uppercase is not in the class
      "short",
      "",
      "11111111-2222-4333-8444-5555555555555", // 37 chars
    ]) {
      expect(await loadPhoto(bad)).toBeNull();
    }
  });

  it("does not serve a file that exists but has a non-UUID name", async () => {
    const { loadPhoto } = await loadPhotos();
    await mkdir(join(dir, "photos"), { recursive: true });
    await writeFile(join(dir, "photos", "secret.jpg"), "nope");
    expect(await loadPhoto("secret")).toBeNull();
  });
});

describe("isValidPhotoId", () => {
  it("accepts a lowercase UUID and rejects everything else", async () => {
    const { isValidPhotoId } = await loadPhotos();
    expect(isValidPhotoId(UUID_A)).toBe(true);
    expect(isValidPhotoId(UUID_B)).toBe(true);
    expect(isValidPhotoId(UUID_B.toUpperCase())).toBe(false);
    expect(isValidPhotoId(undefined)).toBe(false);
    expect(isValidPhotoId(123)).toBe(false);
    expect(isValidPhotoId("../../x")).toBe(false);
  });
});

describe("getPhotoEntry", () => {
  it("returns the index row, or null", async () => {
    const { savePhoto, getPhotoEntry } = await loadPhotos();
    await savePhoto(
      { clientId: "cid-1", imageBase64: b64(jpegFixture(320, 240)), sub: "patient" },
      fixedDeps([UUID_A])
    );
    expect(await getPhotoEntry(UUID_A)).toMatchObject({ width: 320, height: 240, sub: "patient" });
    expect(await getPhotoEntry(UUID_B)).toBeNull();
    expect(await getPhotoEntry("../x")).toBeNull();
  });
});

// ── prunePhotos ─────────────────────────────────────────────────────────────

describe("prunePhotos", () => {
  async function seed(ids: string[], ages: number[]) {
    const { savePhoto } = await loadPhotos();
    for (let i = 0; i < ids.length; i++) {
      await savePhoto(
        { clientId: `cid-${i}`, imageBase64: b64(jpegFixture(100 + i, 100)), sub: "patient" },
        fixedDeps([ids[i]], NOW - ages[i] * DAY)
      );
    }
  }

  it("deletes nothing when every photo is inside the window", async () => {
    const { prunePhotos } = await loadPhotos();
    await seed([UUID_A, UUID_B], [1, 89]);
    expect(await prunePhotos(90, NOW)).toEqual({ deleted: 0 });
    expect(Object.keys(await readIndex())).toHaveLength(2);
    expect(await readdir(join(dir, "photos"))).toHaveLength(2);
  });

  it("deletes the binary and the index row past the cutoff", async () => {
    const { prunePhotos, photoKey } = await loadPhotos();
    await seed([UUID_A, UUID_B], [120, 2]);

    expect(await prunePhotos(90, NOW)).toEqual({ deleted: 1 });
    const index = await readIndex();
    expect(Object.keys(index)).toEqual([UUID_B]);
    await expect(readFile(join(dir, photoKey(UUID_A)))).rejects.toThrow();
    expect(await readFile(join(dir, photoKey(UUID_B)))).toBeTruthy();
  });

  it("defaults to the 90-day retention decision", async () => {
    const { prunePhotos, PHOTO_RETENTION_DAYS } = await loadPhotos();
    expect(PHOTO_RETENTION_DAYS).toBe(90);
    await seed([UUID_A], [91]);
    // Default maxAgeDays, explicit clock.
    expect(await prunePhotos(undefined, NOW)).toEqual({ deleted: 1 });
  });

  it("keeps a photo exactly at the boundary and drops one just past it", async () => {
    const { prunePhotos } = await loadPhotos();
    await seed([UUID_A], [90]);
    // createdAt === cutoff is not "older than", so it survives.
    expect(await prunePhotos(90, NOW)).toEqual({ deleted: 0 });
    expect(await prunePhotos(90, NOW + 1)).toEqual({ deleted: 1 });
  });

  it("honours a shorter retention", async () => {
    const { prunePhotos } = await loadPhotos();
    await seed([UUID_A, UUID_B], [10, 1]);
    expect(await prunePhotos(7, NOW)).toEqual({ deleted: 1 });
    expect(Object.keys(await readIndex())).toEqual([UUID_B]);
  });

  it("is safe on an empty store", async () => {
    const { prunePhotos } = await loadPhotos();
    expect(await prunePhotos(90, NOW)).toEqual({ deleted: 0 });
  });

  it("prunes a row whose createdAt is missing rather than leaving it forever", async () => {
    const { prunePhotos } = await loadPhotos();
    await seed([UUID_A], [1]);
    const index = await readIndex();
    delete index[UUID_A].createdAt;
    await mkdir(join(dir, "meals"), { recursive: true });
    await writeFile(join(dir, "meals", "photos-index.json"), JSON.stringify(index));
    expect(await prunePhotos(90, NOW)).toEqual({ deleted: 1 });
  });

  it("falls back to the default when handed a nonsense retention", async () => {
    const { prunePhotos } = await loadPhotos();
    await seed([UUID_A], [200]);
    // A 0 or negative window would otherwise delete everything, including today.
    expect(await prunePhotos(0, NOW)).toEqual({ deleted: 1 });
    await seed([UUID_B], [1]);
    expect(await prunePhotos(-5, NOW)).toEqual({ deleted: 0 });
  });
});
