import { access, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ManagedAssetRegistry } from "./asset-registry";

it("returns a stable opaque identity for the same original and changes it when the original changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lickety-source-identity-"));
  const file = path.join(directory, "recording.wav");
  try {
    await writeFile(file, "sample");
    const registry = new ManagedAssetRegistry(path.join(directory, "registry"));
    const [first, second] = await Promise.all([registry.identifyOriginal(file), registry.identifyOriginal(file)]);
    expect(first).toEqual(second);
    expect(first.identity).toMatch(/^[a-f0-9]{64}$/i);
    expect(first).toMatchObject({ size: 6 });
    await expect(access(path.join(directory, "registry", "assets.json"))).rejects.toThrow();

    await writeFile(file, "change");
    await utimes(file, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
    const changed = await registry.identifyOriginal(file);
    expect(changed.identity).not.toBe(first.identity);
    await expect(registry.findOriginalMediaId(file, ["existing-media"])).resolves.toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("reuses a registered media ID for the same canonical file and rejects stale references", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lickety-source-reference-"));
  const file = path.join(directory, "recording.wav");
  try {
    await writeFile(file, "sample");
    const registry = new ManagedAssetRegistry(path.join(directory, "registry"));
    await registry.referenceOriginal("existing-media", file);
    await expect(registry.findOriginalMediaId(file, ["existing-media"])).resolves.toBe("existing-media");

    await writeFile(file, "changed");
    await utimes(file, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
    await expect(registry.findOriginalMediaId(file, ["existing-media"])).rejects.toThrow(/changed|relink/i);

    await registry.referenceOriginal("existing-media", file);
    await expect(registry.findOriginalMediaId(file, ["existing-media"])).resolves.toBe("existing-media");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("uses the latest registered media record when checking a saved media ID", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lickety-latest-media-reference-"));
  const first = path.join(directory, "first.wav");
  const second = path.join(directory, "second.wav");
  try {
    await writeFile(first, "first");
    await writeFile(second, "second");
    const registry = new ManagedAssetRegistry(path.join(directory, "registry"));
    await registry.registerOriginal("same-media", first);
    await registry.registerOriginal("same-media", second);
    await expect(registry.findOriginalMediaId(first, ["same-media"])).resolves.toBeUndefined();
    await expect(registry.findOriginalMediaId(second, ["same-media"])).resolves.toBe("same-media");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
