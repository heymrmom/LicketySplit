import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PodcastSetup } from "../../../../../../packages/core/src/lickety/podcast-types";
import { analyzeLegacyPodcastSetup as analyzePodcastSetup } from "./legacy/pipeline";
import { solveGraph as solvePodcastGraph } from "./legacy/matcher";

const makeSetup = (): PodcastSetup => ({
  schemaVersion: 1, setupId: "550e8400-e29b-41d4-a716-446655440000", projectId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8", revision: 0,
  createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z", step: "setup",
  analysis: { version: 1, generatedAt: "2026-10-09T00:00:00.000Z", projectName: "Episode", fps: 30, warnings: [], groups: [], assets: [{
    id: "asset-a", mediaId: "media-a", sourceId: "source-a", name: "Mic 1.wav", kind: "audio", durationSeconds: 23.5,
    sampleRate: 48000, channels: 2, streams: [{ index: 2, kind: "audio", channels: 2, sampleRate: 48000 }],
  }] },
  groups: [{ id: "group-a", name: "Mic 1", kind: "audio", role: "dialogue", confidence: "medium", assetIds: ["asset-a"], warnings: [] }],
  participants: [], clockGroups: [], channels: [], edges: [], placements: [], state: "draft", warnings: [],
});

describe("bounded native podcast analysis", () => {
  it("uses original channels and ten-second windows, caches completed features, and leaves timestamps explicitly unknown", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "podcast-native-test-"));
    try {
      const registry = { findMedia: vi.fn(async () => ({ identity: { assetId: "source-a", mediaId: "media-a", sha256: "a".repeat(64), byteLength: 10 }, originalUri: "licketysplit-media://source-a/original", durationMs: 0 })) };
      const calls: Array<{ startMs: number; durationMs: number; sourceChannelIndex?: number }> = [];
      const audio = { getNativeAudioWindow: vi.fn(async (_id: string, trackIndex: number, startMs: number, durationMs: number, _signal: AbortSignal, sampleRate: number, _channels: number, sourceChannelIndex?: number) => {
        expect(trackIndex).toBe(0); expect(sampleRate).toBe(8000); calls.push({ startMs, durationMs, sourceChannelIndex });
        const startFrame = Math.round(startMs * 8), count = Math.round(durationMs * 8);
        const samples = Float32Array.from({ length: count }, (_, index) => Math.sin((startFrame + index) * 0.071) * 0.35);
        return { channels: [samples], sampleRate };
      }) };
      const args = { setup: makeSetup(), registry: registry as never, audio: audio as never, cacheDir: directory, signal: new AbortController().signal, onProgress: () => undefined };
      const first = await analyzePodcastSetup(args);
      expect(first.metrics.cacheMisses).toBe(2);
      expect(calls.length).toBe(6);
      expect(calls.every((call) => call.durationMs <= 10000)).toBe(true);
      expect(calls.map((call) => call.sourceChannelIndex)).toEqual([0, 0, 0, 1, 1, 1]);
      expect(first.setup.channels).toHaveLength(2);
      expect(first.setup.channels.every((channel) => channel.timestampStatus === "unknown" && channel.firstPTSSeconds === undefined)).toBe(true);
      expect(first.setup.placements[0].status).toBe("reference");

      calls.length = 0;
      const second = await analyzePodcastSetup({ ...args, setup: first.setup });
      expect(second.metrics.cacheHits).toBe(2);
      expect(calls).toHaveLength(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("matches legacy graph composition while retaining unresolved sources and manual authority", () => {
    const edge = (a: string, b: string, offsetSeconds: number) => ({
      a, b, channelA: a, channelB: b, candidates: [], anchors: [], mapping: { version: 1 as const, scale: 1, offsetSeconds },
      status: "measured" as const, reason: "fixture",
    });
    const locked = { assetId: "b", mapping: { version: 1 as const, scale: 1, offsetSeconds: 17 }, component: "a", status: "manual" as const, locked: true, exception: "Editor aligned", provenance: ["manual"] };
    const result = solvePodcastGraph(["a", "b", "c", "d"], "a", [edge("a", "b", 40), edge("b", "c", -55)], [locked]);
    expect(result.map((placement) => [placement.assetId, placement.status, placement.mapping.offsetSeconds])).toEqual([
      ["a", "reference", 0], ["b", "manual", 17], ["c", "measured", -38], ["d", "unresolved", 0],
    ]);
  });

  it("refines the recorder clock network from fitting anchors before flagging cycle conflicts", () => {
    const make = (a: string, b: string, scale: number, offset: number) => ({
      a, b, channelA: `${a}-ch`, channelB: `${b}-ch`, candidates: [],
      mapping: { version: 1 as const, scale, offsetSeconds: offset }, status: "measured" as const, reason: "legacy parity fixture",
      anchors: [10, 60, 120, 190, 260, 320, 400, 470].map((sourceSeconds, index) => ({
        role: index % 2 ? "validation" as const : "fit" as const, sourceSeconds, referenceSeconds: scale * sourceSeconds + offset,
        score: 1, competingScore: 0, polarity: 1, windowSeconds: 6,
      })),
    });
    const edges = [make("a", "b", 1.00002, 15), make("a", "c", 1.00002, 205)];
    const clockGroups = [{ id: "recorder", assetIds: ["b", "c"], confirmed: true, provenance: "legacy test fixture" }];
    const result = solvePodcastGraph(["a", "b", "c"], "a", edges, [], clockGroups);
    expect(result[1].mapping.scale).toBe(result[2].mapping.scale);
    expect(result[1].mapping.scale).toBeCloseTo(1.00002, 10);
    expect(result[2].mapping.offsetSeconds).toBeCloseTo(205, 8);
    expect(result[1].provenance.some((entry) => entry.startsWith("robust-network-fit:"))).toBe(true);
  });

  it("rejects incomplete native windows instead of zero-filling source audio", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "podcast-short-read-"));
    try {
      const registry = { findMedia: vi.fn(async () => ({ identity: { assetId: "source-a", mediaId: "media-a", sha256: "a".repeat(64), byteLength: 10 }, originalUri: "licketysplit-media://source-a/original", durationMs: 0 })) };
      const audio = { getNativeAudioWindow: vi.fn(async (_id: string, _track: number, _start: number, duration: number) => ({ channels: [new Float32Array(Math.round(duration * 8) - 1)], sampleRate: 8000 })) };
      await expect(analyzePodcastSetup({ setup: makeSetup(), registry: registry as never, audio: audio as never, cacheDir: directory, signal: new AbortController().signal, onProgress: () => undefined }))
        .rejects.toThrow("incomplete");
      expect(await readdir(directory)).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("keeps legacy channel matching and graph placement for a source offset beyond thirty seconds", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "podcast-legacy-offset-"));
    try {
      const base = Float32Array.from({ length: 100 * 8000 }, (_, index) => {
        let value = Math.imul(index + 1, 0x45d9f3b) | 0; value ^= value >>> 16; value = Math.imul(value, 0x45d9f3b) | 0; value ^= value >>> 16;
        return ((value >>> 0) / 0x1_0000_0000 - 0.5) * 0.8;
      });
      const setup = makeSetup();
      const first = setup.analysis.assets[0];
      first.durationSeconds = 100; first.streams = [{ index: 0, kind: "audio", channels: 1, sampleRate: 48000, startSeconds: 0, durationSeconds: 100, timestampStatus: "continuous" }];
      const second = { ...structuredClone(first), id: "asset-b", mediaId: "media-b", sourceId: "source-b", name: "Mic 2.wav", durationSeconds: 65 };
      second.streams![0].durationSeconds = 65;
      setup.analysis.assets.push(second); setup.analysis.groups = [];
      setup.groups.push({ id: "group-b", name: "Mic 2", kind: "audio", role: "dialogue", confidence: "high", assetIds: [second.id], warnings: [] });
      const registry = { findMedia: vi.fn(async (mediaId: string) => ({ identity: { assetId: mediaId === "media-b" ? "source-b" : "source-a", mediaId, sha256: mediaId === "media-b" ? "b".repeat(64) : "a".repeat(64), byteLength: base.byteLength }, originalUri: `licketysplit-media://${mediaId}/original`, durationMs: 0 })) };
      const audio = { getNativeAudioWindow: vi.fn(async (sourceId: string, _track: number, startMs: number, durationMs: number, _signal: AbortSignal, sampleRate: number, _channels: number, _sourceChannelIndex?: number) => {
        const start = Math.round(startMs * 8), frames = Math.round(durationMs * 8), offset = sourceId === "source-b" ? 35 * sampleRate : 0;
        return { channels: [base.slice(offset + start, offset + start + frames)], sampleRate };
      }) };
      const result = await analyzePodcastSetup({ setup, registry: registry as never, audio: audio as never, cacheDir: directory, signal: new AbortController().signal, onProgress: () => undefined });
      const edge = result.setup.edges.find((item) => item.a === "asset-a" && item.b === "asset-b");
      expect(edge?.status).toBe("measured");
      expect(edge?.mapping?.offsetSeconds).toBeCloseTo(35, 3);
      expect(edge?.anchors.filter((anchor) => anchor.role === "fit").length).toBeGreaterThanOrEqual(3);
      expect(result.setup.placements.find((placement) => placement.assetId === "asset-b")?.mapping.offsetSeconds).toBeCloseTo(35, 3);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
