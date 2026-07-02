/**
 * ClearSugar — Local filesystem storage
 *
 * Simple JSON file persistence for alert state, push tokens, and reports.
 * Data directory defaults to /opt/clearsugar/data (production) or .data/ (dev).
 */

import { readFile, writeFile, unlink, readdir, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

const DATA_DIR = process.env.CLEARSUGAR_DATA_DIR || join(process.cwd(), ".data");

function filePath(key: string): string {
  return join(DATA_DIR, key);
}

/** Read and parse a JSON file, returning fallback if missing or invalid. */
export async function loadJSON<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath(key), "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Write a JSON value to disk, creating parent directories as needed. */
export async function saveJSON(key: string, data: unknown): Promise<void> {
  const fp = filePath(key);
  await mkdir(dirname(fp), { recursive: true });
  await writeFile(fp, JSON.stringify(data, null, 2));
}

/** Delete a JSON file. Ignores missing files. */
export async function deleteJSON(key: string): Promise<void> {
  try {
    await unlink(filePath(key));
  } catch {
    // ignore ENOENT
  }
}

/** List filenames under a prefix directory. Returns keys relative to DATA_DIR. */
export async function listKeys(prefix: string): Promise<string[]> {
  try {
    const dir = join(DATA_DIR, prefix);
    const files = await readdir(dir);
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => `${prefix}${f}`);
  } catch {
    return [];
  }
}
