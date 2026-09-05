import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cs-store-"));
  process.env.CLEARSUGAR_DATA_DIR = dir;
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("saveJSON atomicity", () => {
  it("never leaves a partial file visible to a concurrent reader", async () => {
    const { saveJSON, loadJSON } = await import("../local-store");
    await saveJSON("k.json", { seed: true });
    // Interleave many writers and readers; every read must parse a COMPLETE object.
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 300; i++) {
      ops.push(saveJSON("k.json", { n: i, blob: "x".repeat(16384) }));
      ops.push(
        loadJSON<{ n?: number; seed?: boolean; fallback?: boolean }>("k.json", { fallback: true }).then((v) => {
          // Fallback is only returned on a read error (e.g. torn file). With atomic
          // rename the file is always whole, so we must never see the fallback.
          expect(v.fallback).toBeUndefined();
        })
      );
    }
    await Promise.all(ops);
  });

  it("leaves no .tmp files behind", async () => {
    const { saveJSON } = await import("../local-store");
    await saveJSON("k.json", { ok: 1 });
    const files = await readdir(dir);
    expect(files.filter((f) => f.includes(".tmp"))).toHaveLength(0);
  });
});
