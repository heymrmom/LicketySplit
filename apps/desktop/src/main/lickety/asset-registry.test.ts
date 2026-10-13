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

it("resolves a registered original for preview from its saved fingerprint without hashing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lickety-preview-reference-"));
  const file = path.join(directory, "camera.mov");
  try {
    await writeFile(file, "sample");
    const registry = new ManagedAssetRegistry(path.join(directory, "registry"));
    const asset = await registry.registerOriginal("camera", file);
    await expect(registry.originalPreviewUri("camera")).resolves.toBe(asset.originalUri);
    await writeFile(file, "changed");
    await utimes(file, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
    await expect(registry.originalPreviewUri("camera")).rejects.toThrow(/changed|relink/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("peeks a ready preview receipt without scheduling registration or proxy work", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lickety-ready-preview-"));
  const file = path.join(directory, "camera.mov");
  try {
    await writeFile(file, "source");
    const registry = new ManagedAssetRegistry(path.join(directory, "registry"));
    const asset = await registry.registerOriginal("camera", file);
    const proxy = path.join(registry.cacheDir, "camera.mp4");
    await writeFile(proxy, "proxy");
    const receipt = { assetId: asset.identity.assetId, sourceSha256: asset.identity.sha256, proxyUri: asset.originalUri.replace("/original", "/proxy"), width: 960, height: 540, sourceStartPTS: 0, proxyStartPTS: 0, durationMs: 1000, version: 1 as const };
    await registry.promoteProxy(asset.identity.assetId, proxy, receipt);
    await expect(registry.readyProxyReceipt(asset.identity.assetId)).resolves.toEqual(receipt);
    const reopened = new ManagedAssetRegistry(path.join(directory, "registry"));
    await expect(reopened.readyProxyReceipt(asset.identity.assetId)).resolves.toEqual(receipt);
    await expect(reopened.trimDerivedCache(0, "unrelated-active-asset", 0)).rejects.toThrow(/active files/i);
    await expect(access(proxy)).resolves.toBeUndefined();
    await writeFile(file, "changed");
    await utimes(file, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
    await expect(registry.readyProxyReceipt(asset.identity.assetId)).rejects.toThrow(/changed|relink/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
