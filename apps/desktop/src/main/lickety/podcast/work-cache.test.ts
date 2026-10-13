import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { cachedPodcastWork } from "./work-cache";

it("reuses only checksum-valid completed work and invalidates identity changes", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "podcast-work-cache-"));
  try {
    const compute = vi.fn(async () => ({ status: "measured", offset: 0.125 }));
    const identity = { sourceSha256: "a".repeat(64), algorithm: "legacy-sync-v1" };
    expect((await cachedPodcastWork(folder, "match", identity, compute)).value).toEqual(await cachedPodcastWork(folder, "match", identity, compute).then((result) => result.value));
    expect(compute).toHaveBeenCalledTimes(1);
    const file = path.join(folder, (await readdir(folder))[0]);
    const saved = JSON.parse(await readFile(file, "utf8")); saved.value.offset = 99;
    await writeFile(file, JSON.stringify(saved));
    expect((await cachedPodcastWork(folder, "match", identity, compute)).value.offset).toBe(0.125);
    await cachedPodcastWork(folder, "match", { ...identity, sourceSha256: "b".repeat(64) }, compute);
    expect(compute).toHaveBeenCalledTimes(3);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

it("does not publish work when cancellation arrives before commit", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "podcast-work-cancel-"));
  try {
    const controller = new AbortController();
    await expect(cachedPodcastWork(folder, "match", "cancelled", async () => { controller.abort(); return { value: 1 }; }, controller.signal)).rejects.toThrow();
    expect(await readdir(folder)).toEqual([]);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
