import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicJson } from "../asset-registry";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Reuse only completed work whose identity and value checksum both validate. */
export async function cachedPodcastWork<T>(
  folder: string,
  stage: string,
  identity: unknown,
  operation: () => Promise<T>,
  signal?: AbortSignal,
  validate?: (value: unknown) => value is T,
): Promise<{ value: T; cacheHit: boolean; file: string }> {
  signal?.throwIfAborted();
  const key = digest({ version: 1, stage, identity });
  const file = path.join(folder, `${key}.json`);
  try {
    const saved = JSON.parse(await readFile(file, "utf8")) as { key?: unknown; value?: T; checksum?: unknown };
    if (saved.key === key && saved.checksum === digest(saved.value) && (!validate || validate(saved.value))) {
      signal?.throwIfAborted();
      return { value: saved.value as T, cacheHit: true, file };
    }
  } catch {
    signal?.throwIfAborted();
  }
  const value = await operation();
  signal?.throwIfAborted();
  await mkdir(folder, { recursive: true });
  await atomicJson(file, { key, value, checksum: digest(value) });
  signal?.throwIfAborted();
  return { value, cacheHit: false, file };
}

export const podcastCacheDigest = digest;

export async function readPodcastWorkCache<T>(folder: string, key: string, validate?: (value: unknown) => value is T): Promise<T | undefined> {
  try {
    const saved = JSON.parse(await readFile(path.join(folder, `${key}.json`), "utf8")) as { key?: unknown; value?: T; checksum?: unknown };
    if (saved.key !== key || saved.checksum !== digest(saved.value) || (validate && !validate(saved.value))) return undefined;
    return saved.value as T;
  } catch { return undefined; }
}
