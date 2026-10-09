import { mkdtemp, rm } from "node:fs/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NativeAudioAnalysis } from "../audio-analysis";
import { PodcastNativeService } from "./service";
import { nativeSetupMappingDigest } from "./legacy/approval";
import { analyzeLegacyPodcastSetup } from "./legacy/pipeline";
import { cachedPodcastWork } from "./work-cache";

const projectId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const sourceA = "550e8400-e29b-41d4-a716-446655440000";
const sourceB = "550e8400-e29b-41d4-a716-446655440001";

function makeHarness() {
  const originals = new Map([["media-a", sourceA], ["media-b", sourceB]]);
  const registry = {
    originalUri: vi.fn(async (mediaId: string) => {
      const sourceId = originals.get(mediaId);
      return sourceId ? `licketysplit-media://${sourceId}/original` : undefined;
    }),
    resolve: vi.fn(async (assetId: string) => ({ path: `/registered/${assetId}.wav`, mime: "audio/wav" })),
    findMedia: vi.fn(async (mediaId: string) => {
      const sourceId = originals.get(mediaId);
      if (!sourceId) return undefined;
      return { identity: { assetId: sourceId, mediaId, sha256: (mediaId === "media-a" ? "a" : "b").repeat(64), byteLength: 10 }, originalUri: `licketysplit-media://${sourceId}/original`, durationMs: 30_000 };
    }),
  };
  const streams = [{ index: 0, kind: "audio" as const, codec: "pcm_s16le", sampleRate: 48000, channels: 1, startSeconds: 0, durationSeconds: 30, timestampStatus: "continuous" as const }];
  const inspect = vi.fn(async () => ({ metadata: { duration: 30, width: 0, height: 0, frameRate: 0, codec: "pcm_s16le", sampleRate: 48000, channels: 1, fileSize: 10, hasVideo: false, hasAudio: true }, streams }));
  const inspectPackets = vi.fn(async (_sourcePath: string, signal: AbortSignal) => { signal.throwIfAborted(); return { streams, warnings: [], containerStartSeconds: 0 }; });
  const serviceWith = (directory: string, audio: NativeAudioAnalysis) => new PodcastNativeService(directory, registry as never, audio, inspect, inspectPackets);
  return { registry, inspect, inspectPackets, originals, serviceWith };
}

describe("native podcast setup revision and live analysis", () => {
  it("removes deselected recordings while preserving the remaining confirmed group", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "podcast-service-revise-"));
    try {
      const harness = makeHarness(), service = harness.serviceWith(directory, {} as NativeAudioAnalysis);
      const first = await service.inspect({ projectId, mediaIds: ["media-a", "media-b"] });
      expect(harness.inspectPackets).not.toHaveBeenCalled();
      const retained = first.groups.find((group) => group.assetIds.includes(first.analysis.assets.find((asset) => asset.mediaId === "media-b")!.id))!;
      retained.name = "Confirmed boom mic"; retained.role = "dialogue"; retained.confidence = "high";
      retained.recordingLink = { id: "link-confirmed", kind: "simultaneous" };
      await service.revise({ setupId: first.setupId, groups: first.groups, participants: [] });

      const revised = await service.inspect({ projectId, setupId: first.setupId, mediaIds: ["media-b"] });
      expect(revised.analysis.assets.map((asset) => asset.mediaId)).toEqual(["media-b"]);
      expect(revised.groups).toHaveLength(1);
      expect(revised.groups[0]).toMatchObject({ name: "Confirmed boom mic", role: "dialogue", confidence: "high", recordingLink: { id: "link-confirmed", kind: "simultaneous" } });
      expect(revised.groups[0].assetIds).toEqual([revised.analysis.assets[0].id]);
      expect(revised.sourceHistory?.some((entry) => entry.asset?.mediaId === "media-a")).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("get remains read-only while this process owns an in-flight analysis", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "podcast-service-live-"));
    let entered!: () => void, release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    try {
      const harness = makeHarness();
      const audio = { getNativeAudioWindow: vi.fn(async (_sourceId: string, _trackIndex: number, _startMs: number, durationMs: number, signal: AbortSignal) => {
        entered();
        await Promise.race([releasePromise, new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
        return { channels: [new Float32Array(Math.round(durationMs * 8))], sampleRate: 8000 };
      }) };
      const service = harness.serviceWith(directory, audio as never);
      const setup = await service.inspect({ projectId, mediaIds: ["media-a"] });
      const controller = new AbortController();
      const inFlight = service.analyze(setup.setupId, "550e8400-e29b-41d4-a716-446655440099", controller.signal, () => undefined);
      const settled = inFlight.catch((error: unknown) => error);
      try {
        await enteredPromise;
        expect(harness.inspectPackets).toHaveBeenCalledTimes(1);
        expect((await service.get(setup.setupId)).state).toBe("analyzing");
        controller.abort(new Error("test cancellation"));
        expect(await settled).toMatchObject({ message: "test cancellation" });
      } finally { controller.abort(new Error("test cleanup")); release(); await settled; }
    } finally { release(); await rm(directory, { recursive: true, force: true }); }
  });

  it("keeps confirmed recorder-clock timing together when a manual edit would split it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "podcast-clock-update-"));
    try {
      const harness = makeHarness(), service = harness.serviceWith(directory, {} as NativeAudioAnalysis);
      const setup = await service.inspect({ projectId, mediaIds: ["media-a", "media-b"] });
      const [a, b] = setup.analysis.assets;
      setup.referenceAssetId = a.id; setup.state = "review";
      setup.clockGroups = [{ id: "confirmed", assetIds: [a.id, b.id], confirmed: true, provenance: "same recorder", sourceStarts: { [a.id]: 0, [b.id]: 0 } }];
      setup.placements = [
        { assetId: a.id, mapping: { version: 1, scale: 1, offsetSeconds: 0 }, status: "reference", component: a.id, locked: false, provenance: [] },
        { assetId: b.id, mapping: { version: 1, scale: 1, offsetSeconds: 0 }, status: "measured", component: a.id, locked: false, provenance: [] },
      ];
      await mkdir(path.join(directory, "setups"), { recursive: true });
      await writeFile(path.join(directory, "setups", `${setup.setupId}.json`), JSON.stringify(setup));
      await expect(service.update({ setupId: setup.setupId, assetId: b.id, offsetSeconds: 1, note: "manual shift" })).rejects.toThrow("These files were confirmed as one recording");
      const persisted = JSON.parse(await readFile(path.join(directory, "setups", `${setup.setupId}.json`), "utf8"));
      expect(persisted.placements[1].mapping.offsetSeconds).toBe(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("invalidates a restored approval after its saved mapping changes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "podcast-stale-approval-"));
    try {
      const harness = makeHarness(), service = harness.serviceWith(directory, {} as NativeAudioAnalysis);
      const setup = await service.inspect({ projectId, mediaIds: ["media-a"] });
      const asset = setup.analysis.assets[0];
      setup.referenceAssetId = asset.id; setup.state = "approved";
      setup.placements = [{ assetId: asset.id, mapping: { version: 1, scale: 1, offsetSeconds: 0 }, status: "reference", component: asset.id, locked: false, provenance: [] }];
      setup.approval = { revision: setup.revision, mappingDigest: nativeSetupMappingDigest(setup), approvedAt: new Date().toISOString() };
      await mkdir(path.join(directory, "setups"), { recursive: true });
      const file = path.join(directory, "setups", `${setup.setupId}.json`);
      await writeFile(file, JSON.stringify(setup));
      const changed = JSON.parse(await readFile(file, "utf8"));
      changed.placements[0].mapping.offsetSeconds = 0.5;
      await writeFile(file, JSON.stringify(changed));
      const restored = await service.get(setup.setupId);
      expect(restored.state).toBe("draft");
      expect(restored.approval).toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("invalidates an approved setup when an included registry source is relinked", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "podcast-stale-source-"));
    try {
      const harness = makeHarness(), service = harness.serviceWith(directory, {} as NativeAudioAnalysis);
      const setup = await service.inspect({ projectId, mediaIds: ["media-a"] });
      const asset = setup.analysis.assets[0]; asset.sourceDigest = "a".repeat(64);
      setup.referenceAssetId = asset.id; setup.state = "approved";
      setup.placements = [{ assetId: asset.id, mapping: { version: 1, scale: 1, offsetSeconds: 0 }, status: "reference", component: asset.id, locked: false, provenance: [] }];
      setup.approval = { revision: setup.revision, mappingDigest: nativeSetupMappingDigest(setup), approvedAt: new Date().toISOString() };
      await mkdir(path.join(directory, "setups"), { recursive: true });
      await writeFile(path.join(directory, "setups", `${setup.setupId}.json`), JSON.stringify(setup));
      harness.originals.set("media-a", sourceB);
      const restored = await service.get(setup.setupId);
      expect(restored.state).toBe("draft");
      expect(restored.approval).toBeUndefined();
      expect(restored.placements[0].mapping.offsetSeconds).toBe(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("does not let a delayed approval repair overwrite a concurrent manual timing update", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "podcast-get-update-race-"));
    let release!: () => void, entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const harness = makeHarness(), service = harness.serviceWith(directory, {} as NativeAudioAnalysis);
      const setup = await service.inspect({ projectId, mediaIds: ["media-a", "media-b"] });
      const [a, b] = setup.analysis.assets;
      a.sourceDigest = "a".repeat(64); b.sourceDigest = "b".repeat(64);
      setup.referenceAssetId = a.id; setup.state = "approved";
      setup.placements = [
        { assetId: a.id, mapping: { version: 1, scale: 1, offsetSeconds: 0 }, status: "reference", component: a.id, locked: false, provenance: [] },
        { assetId: b.id, mapping: { version: 1, scale: 1, offsetSeconds: 0 }, status: "measured", component: a.id, locked: false, provenance: [] },
      ];
      setup.approval = { revision: setup.revision, mappingDigest: nativeSetupMappingDigest(setup), approvedAt: new Date().toISOString() };
      await mkdir(path.join(directory, "setups"), { recursive: true });
      await writeFile(path.join(directory, "setups", `${setup.setupId}.json`), JSON.stringify(setup));
      const originalUri = harness.registry.originalUri;
      harness.registry.originalUri = vi.fn(async (mediaId: string) => {
        if (mediaId === "media-a") { entered(); await gate; }
        return originalUri(mediaId);
      });

      const restoring = service.get(setup.setupId);
      await enteredPromise;
      harness.originals.set("media-a", sourceB);
      await service.update({ setupId: setup.setupId, assetId: b.id, offsetSeconds: 10, note: "Keep this manual timing change" });
      release();
      const restored = await restoring;
      expect(restored.revision).toBe(setup.revision + 1);
      expect(restored.state).toBe("review");
      expect(restored.placements.find((placement) => placement.assetId === b.id)?.mapping.offsetSeconds).toBe(10);
      expect(restored.approval).toBeUndefined();
    } finally { release(); await rm(directory, { recursive: true, force: true }); }
  });

  it("preserves legacy grouping order and placements through the public adapter on the same source fixture", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "podcast-legacy-parity-"));
    const legacyCache = path.join(directory, "legacy-cache");
    try {
      const harness = makeHarness();
      const base = Float32Array.from({ length: 100 * 8000 }, (_, index) => {
        let value = Math.imul(index + 1, 0x45d9f3b) | 0; value ^= value >>> 16; value = Math.imul(value, 0x45d9f3b) | 0; value ^= value >>> 16;
        return ((value >>> 0) / 0x1_0000_0000 - 0.5) * 0.8;
      });
      const stream = (durationSeconds: number) => [{ index: 0, kind: "audio" as const, codec: "pcm_s16le", sampleRate: 48000, channels: 1, startSeconds: 0, durationSeconds, timestampStatus: "continuous" as const }];
      const durationFor = (sourcePath: string) => sourcePath.includes(sourceA) ? 100 : 65;
      const inspect = async (sourcePath: string) => {
        const duration = durationFor(sourcePath);
        return { metadata: { duration, width: 0, height: 0, frameRate: 0, codec: "pcm_s16le", sampleRate: 48000, channels: 1, fileSize: 10, hasVideo: false, hasAudio: true }, streams: stream(duration), containerStartSeconds: 0 };
      };
      const inspectPackets = async (sourcePath: string, signal: AbortSignal) => {
        signal.throwIfAborted(); const duration = durationFor(sourcePath);
        return { streams: stream(duration), warnings: [], containerStartSeconds: 0 };
      };
      const audio = { getNativeAudioWindow: vi.fn(async (sourceId: string, _trackIndex: number, startMs: number, durationMs: number, signal: AbortSignal) => {
        signal.throwIfAborted();
        const from = Math.round(startMs * 8), frames = Math.round(durationMs * 8), sourceOffset = sourceId === sourceB ? 35 * 8000 : 0;
        return { channels: [base.slice(sourceOffset + from, sourceOffset + from + frames)], sampleRate: 8000 };
      }) };
      const service = new PodcastNativeService(directory, harness.registry as never, audio as never, inspect, inspectPackets);
      const initial = await service.inspect({ projectId, mediaIds: ["media-a", "media-b"] });
      const sameInput = structuredClone(initial);
      const legacy = await analyzeLegacyPodcastSetup({ setup: sameInput, registry: harness.registry as never, audio: audio as never, cacheDir: legacyCache, signal: new AbortController().signal, onProgress: () => undefined });
      const adapted = await service.analyze(initial.setupId, "550e8400-e29b-41d4-a716-446655440099", new AbortController().signal, () => undefined);

      const grouping = (setup: typeof initial) => setup.groups.map(({ id: _id, name, kind, role, assetIds }) => ({ name, kind, role, assetIds }));
      const placements = (setup: typeof initial) => setup.placements.map(({ assetId, mapping, status, component }) => ({ assetId, scale: mapping.scale, offsetSeconds: mapping.offsetSeconds, status, component }));
      expect(grouping(adapted)).toEqual(grouping(legacy.setup));
      expect(adapted.analysis.assets.map((asset) => asset.id)).toEqual(legacy.setup.analysis.assets.map((asset) => asset.id));
      expect(adapted.edges.map(({ a, b, status, mapping }) => ({ a, b, status, scale: mapping?.scale, offsetSeconds: mapping?.offsetSeconds })))
        .toEqual(legacy.setup.edges.map(({ a, b, status, mapping }) => ({ a, b, status, scale: mapping?.scale, offsetSeconds: mapping?.offsetSeconds })));
      expect(placements(adapted)).toEqual(placements(legacy.setup));
      expect(adapted.placements.find((placement) => placement.assetId !== adapted.referenceAssetId)?.mapping.offsetSeconds).toBeCloseTo(35, 3);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("serves bounded waveform peaks from the checksummed prepared sidecar", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "podcast-waveform-"));
    try {
      const harness = makeHarness(), service = harness.serviceWith(directory, {} as NativeAudioAnalysis);
      const setup = await service.inspect({ projectId, mediaIds: ["media-a"] });
      setup.channels = [{ id: "wave-channel", assetId: setup.analysis.assets[0].id, sourceId: sourceA, streamIndex: 0, channel: 0,
        cacheKey: "wave-feature-cache", usable: true, rms: 0.2, sampleRate: 8000, frames: 2560, firstPTSSeconds: 2, timestampStatus: "continuous" }];
      await mkdir(path.join(directory, "analysis"), { recursive: true });
      await cachedPodcastWork(path.join(directory, "analysis"), "channel-waveform-v1", { featureCacheKey: "wave-feature-cache", frames: 2560 }, async () => ({ version: 1, featureCacheKey: "wave-feature-cache", frames: 2560, min: Array.from({ length: 10 }, (_, index) => -index - 1), max: Array.from({ length: 10 }, (_, index) => index + 1) }));
      await mkdir(path.join(directory, "setups"), { recursive: true });
      await writeFile(path.join(directory, "setups", `${setup.setupId}.json`), JSON.stringify(setup));
      const waveform = await service.getWaveform({ setupId: setup.setupId, channelId: "wave-channel", startSeconds: 2, durationSeconds: 0.32, maxPoints: 2 });
      expect(waveform).toMatchObject({ channelId: "wave-channel", sourceStartSeconds: 2, durationSeconds: 0.32, secondsPerPeak: 0.16, min: [-5, -10], max: [5, 10] });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("preserves saved mappings through group reorder and invalidates only a changed channel binding", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "podcast-group-revision-"));
    try {
      const harness = makeHarness(), service = harness.serviceWith(directory, {} as NativeAudioAnalysis);
      const setup = await service.inspect({ projectId, mediaIds: ["media-a", "media-b"] });
      const [a, b] = setup.analysis.assets;
      setup.referenceAssetId = a.id;
      setup.placements = [
        { assetId: a.id, mapping: { version: 1, scale: 1, offsetSeconds: 0 }, status: "reference", component: a.id, locked: false, provenance: [] },
        { assetId: b.id, mapping: { version: 1, scale: 1, offsetSeconds: 0 }, status: "measured", component: a.id, locked: false, provenance: [] },
      ];
      setup.state = "review";
      await mkdir(path.join(directory, "setups"), { recursive: true });
      await writeFile(path.join(directory, "setups", `${setup.setupId}.json`), JSON.stringify(setup));
      const reordered = await service.revise({ setupId: setup.setupId, groups: [...setup.groups].reverse(), participants: [] });
      expect(reordered.placements.map((item) => item.assetId).sort()).toEqual([a.id, b.id].sort());
      const groupB = reordered.groups.find((group) => group.assetIds.includes(b.id))!;
      const rebound = await service.revise({ setupId: setup.setupId, groups: reordered.groups.map((group) => group.id === groupB.id ? { ...group, audioBindings: [{ assetId: b.id, streamIndex: 0, channel: 0 }] } : group), participants: [] });
      expect(rebound.placements.map((item) => item.assetId)).toEqual([a.id]);
      expect(rebound.sourceHistory?.some((entry) => entry.assetId === b.id && entry.placement)).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("drops review checks whose nested channel alternatives were invalidated by a binding edit", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "podcast-review-candidate-revision-"));
    try {
      const harness = makeHarness(), service = harness.serviceWith(directory, {} as NativeAudioAnalysis);
      const setup = await service.inspect({ projectId, mediaIds: ["media-a", "media-b"] });
      const [a, b] = setup.analysis.assets;
      setup.channels = [
        { id: "channel-a", assetId: a.id, sourceId: a.sourceId, streamIndex: 0, channel: 0, cacheKey: "cache-a", usable: true, rms: 0.2, sampleRate: 8000, frames: 240_000, firstPTSSeconds: 0, timestampStatus: "continuous" },
        { id: "channel-b", assetId: b.id, sourceId: b.sourceId, streamIndex: 0, channel: 0, cacheKey: "cache-b", usable: true, rms: 0.2, sampleRate: 8000, frames: 240_000, firstPTSSeconds: 0, timestampStatus: "continuous" },
      ];
      setup.reviewChecks = [{
        assetId: a.id, channelId: "channel-a", referenceChannelId: "channel-a", projectSeconds: 10, sourceSeconds: 10, referenceSeconds: 10,
        windowSeconds: 6, fitOverlap: false, score: 0.9, competingScore: 0.2, residualMs: 1, status: "pass",
        candidates: [{ channelId: "channel-a", referenceChannelId: "channel-b", sourceSeconds: 10, referenceSeconds: 10, fitOverlap: false, usable: true, score: 0.9, competingScore: 0.2, residualMs: 1, subwindows: [] }],
      }];
      setup.regionEvidence = [{ assetId: a.id, role: "validation", channelId: "channel-a", referenceChannelId: "channel-b", sourceSeconds: 10, referenceSeconds: 10,
        projectSeconds: 10, observedProjectSeconds: 10, windowSeconds: 6, fitOverlap: false, usable: true, score: 0.9, competingScore: 0.2, residualMs: 1, subwindows: [] }];
      await mkdir(path.join(directory, "setups"), { recursive: true });
      await writeFile(path.join(directory, "setups", `${setup.setupId}.json`), JSON.stringify(setup));
      const groupB = setup.groups.find((group) => group.assetIds.includes(b.id))!;

      const revised = await service.revise({ setupId: setup.setupId, groups: setup.groups.map((group) => group.id === groupB.id ? { ...group, audioBindings: [{ assetId: b.id, streamIndex: 0, channel: 0 }] } : group), participants: [] });

      expect(revised.channels.some((channel) => channel.id === "channel-b")).toBe(false);
      expect(revised.reviewChecks).toEqual([]);
      expect(revised.regionEvidence).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("does not let a human acceptance waive unknown source timing during approval", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "podcast-approval-blocker-"));
    try {
      const harness = makeHarness(), service = harness.serviceWith(directory, {} as NativeAudioAnalysis);
      const setup = await service.inspect({ projectId, mediaIds: ["media-a"] });
      const assetId = setup.analysis.assets[0].id;
      setup.analysis.assets[0].sourceDigest = "a".repeat(64);
      setup.referenceAssetId = assetId; setup.state = "review";
      setup.placements = [{ assetId, mapping: { version: 1, scale: 1, offsetSeconds: 0 }, status: "manual", component: assetId, locked: false,
        provenance: [], exception: "checked", humanAcceptance: { scope: "recording", note: "checked", at: new Date().toISOString() }, unsupported: ["Audio presentation origin is unknown."] }];
      await mkdir(path.join(directory, "setups"), { recursive: true });
      await writeFile(path.join(directory, "setups", `${setup.setupId}.json`), JSON.stringify(setup));
      await expect(service.approve(setup.setupId, setup.revision)).rejects.toThrow("unwaived unsupported timing");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
