/**
 * ClearSugar — Local filesystem storage
 *
 * Simple JSON file persistence for alert state, push tokens, and reports.
 * Data directory defaults to /opt/clearsugar/data (production) or .data/ (dev).
 */

import { readFile, writeFile, rename, unlink, readdir, mkdir } from "node:fs/promises";
import { join, dirname, isAbsolute, win32 } from "node:path";

const DATA_DIR = process.env.CLEARSUGAR_DATA_DIR || join(process.cwd(), ".data");

// Monotonic counter for unique temp-file names. process.pid + this guarantees no
// collision even when many saveJSON calls race on the same key in one process
// (Date.now() alone collides within a millisecond → concurrent writes corrupt the temp).
let saveSeq = 0;

function filePath(key: string): string {
  if (key.includes("..") || isAbsolute(key) || win32.isAbsolute(key)) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  return join(DATA_DIR, key);
}

/** Read and parse a JSON file, returning fallback if missing or invalid. */
export async function loadJSON<T>(key: string, fallback: T): Promise<T> {
  const fp = filePath(key);
  try {
    const raw = await readFile(fp, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const mutations = new Map<string, Promise<unknown>>();

/** Serialize a complete read/modify/write operation within this server process. */
export async function withStoreLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = mutations.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  mutations.set(key, next);
  try { return await next; }
  finally { if (mutations.get(key) === next) mutations.delete(key); }
}

async function atomicWrite(key: string, data: string | Uint8Array): Promise<void> {
  const fp = filePath(key);
  await withStoreLock('write:' + key, async () => {
    await mkdir(dirname(fp), { recursive: true });
    const tmp = fp + '.tmp-' + process.pid + '-' + saveSeq++;
    try {
      await writeFile(tmp, data);
      for (let attempt = 0; ; attempt++) {
        try { await rename(tmp, fp); break; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 8) throw error;
          await new Promise(resolve => setTimeout(resolve, 5 * (attempt + 1)));
        }
      }
    } finally {
      await unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  });
}

export async function saveJSON(key: string, data: unknown): Promise<void> {
  await atomicWrite(key, JSON.stringify(data, null, 2));
}

export async function saveBinary(key: string, data: Buffer | Uint8Array): Promise<void> {
  await atomicWrite(key, data);
}

/** Read binary data, returning null if the key is missing. */
export async function loadBinary(key: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath(key));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Delete a JSON file. Ignores missing files. */
export async function deleteJSON(key: string): Promise<void> {
  const fp = filePath(key);
  try {
    await unlink(fp);
  } catch {
    // ignore ENOENT
  }
}

/** Delete a binary file. Ignores missing files. */
export async function deleteBinary(key: string): Promise<void> {
  await deleteJSON(key);
}

/** List filenames under a prefix directory. Returns keys relative to DATA_DIR. */
export async function listKeys(prefix: string): Promise<string[]> {
  const dir = filePath(prefix);
  try {
    const files = await readdir(dir);
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => `${prefix}${f}`);
  } catch {
    return [];
  }
}
