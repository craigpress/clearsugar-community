import { AsyncLocalStorage } from "node:async_hooks";
import * as storage from "@/lib/local-store";

import type { MealProfile } from "./profiles";
export const mealScope = new AsyncLocalStorage<MealProfile>();
export const currentMealChild = () => mealScope.getStore()?.id ?? "patient";
export const isTestMeal = () => mealScope.getStore()?.isTest ?? false;
export const isLocalMeal = () => currentMealChild() !== "patient" || process.env.DEMO_MODE === "true";
const prefix = () => currentMealChild() !== "patient" ? `meal-profiles/${currentMealChild()}/` : "";
const scopedKey = (key: string) => prefix() + key;

export const loadJSON = <T>(key: string, fallback: T) => storage.loadJSON(scopedKey(key), fallback);
export const saveJSON = (key: string, value: unknown) => storage.saveJSON(scopedKey(key), value);
export const loadBinary = (key: string) => storage.loadBinary(scopedKey(key));
export const saveBinary = (key: string, value: Buffer | Uint8Array) => storage.saveBinary(scopedKey(key), value);
export const deleteBinary = (key: string) => storage.deleteBinary(scopedKey(key));
export const deleteJSON = (key: string) => storage.deleteJSON(scopedKey(key));
export const withStoreLock = <T>(key: string, action: () => Promise<T>) => storage.withStoreLock(scopedKey(key), action);
export async function listKeys(key: string): Promise<string[]> {
  const base = prefix();
  return (await storage.listKeys(base + key)).map(value => value.slice(base.length));
}
