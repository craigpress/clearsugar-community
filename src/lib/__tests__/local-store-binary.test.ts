import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cs-store-binary-"));
  process.env.CLEARSUGAR_DATA_DIR = dir;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.CLEARSUGAR_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("binary local storage", () => {
  it("round-trips exact bytes", async () => {
    const { loadBinary, saveBinary } = await import("../local-store");
    const bytes = Uint8Array.from([0, 1, 2, 127, 128, 255]);
    await saveBinary("photo.bin", bytes);
    expect(await loadBinary("photo.bin")).toEqual(Buffer.from(bytes));
  });

  it("returns null for a missing key", async () => {
    const { loadBinary } = await import("../local-store");
    expect(await loadBinary("missing.bin")).toBeNull();
  });

  it("creates nested key directories", async () => {
    const { saveBinary } = await import("../local-store");
    await saveBinary("meals/photos/image.bin", Buffer.from("image"));
    expect(await readFile(join(dir, "meals", "photos", "image.bin"))).toEqual(Buffer.from("image"));
  });

  it.each(["../escape.bin", "nested/../escape.bin", "C:\\absolute.bin"])(
    "rejects path traversal key %s",
    async (key) => {
      const { loadBinary, saveBinary, deleteBinary } = await import("../local-store");
      await expect(saveBinary(key, Buffer.from([1]))).rejects.toThrow("Invalid storage key");
      await expect(loadBinary(key)).rejects.toThrow("Invalid storage key");
      await expect(deleteBinary(key)).rejects.toThrow("Invalid storage key");
    },
  );

  it("deletes binary keys and ignores missing keys", async () => {
    const { deleteBinary, loadBinary, saveBinary } = await import("../local-store");
    await saveBinary("delete.bin", Buffer.from([1, 2, 3]));
    await deleteBinary("delete.bin");
    expect(await loadBinary("delete.bin")).toBeNull();
    await expect(deleteBinary("delete.bin")).resolves.toBeUndefined();
  });
});
