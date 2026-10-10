import { describe, expect, it } from "vitest";
import { assertPodcastSetup, type PodcastSetup } from "./podcast-types";

const setup = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  setupId: "550e8400-e29b-41d4-a716-446655440000",
  projectId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
  revision: 0,
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: "2026-10-09T00:00:00.000Z",
  step: "setup",
  analysis: {
    version: 1,
    generatedAt: "2026-10-09T00:00:00.000Z",
    projectName: "Episode",
    fps: 30,
    groups: [],
    assets: [{ id: "asset-a", mediaId: "media-a", sourceId: "registry-a", name: "A.mov", kind: "video", durationSeconds: 10 }],
    warnings: [],
  },
  groups: [{ id: "camera-a", name: "Camera A", kind: "video", role: "camera", confidence: "high", assetIds: ["asset-a"], warnings: [] }],
  participants: [],
  clockGroups: [],
  channels: [],
  edges: [],
  placements: [],
  state: "draft",
  warnings: [],
  ...overrides,
});

describe("portable podcast setup", () => {
  it("rejects a group that references a source outside its inventory", () => {
    expect(() => assertPodcastSetup(setup({
      groups: [{ id: "camera-a", name: "Camera A", kind: "video", role: "camera", confidence: "high", assetIds: ["missing"], warnings: [] }],
    }))).toThrow(/unknown source/i);
  });

  it("rejects native filesystem paths in persisted analysis", () => {
    const value = setup({
      analysis: {
        version: 1,
        generatedAt: "2026-10-09T00:00:00.000Z",
        projectName: "Episode",
        fps: 30,
        mediaRoot: "/Users/editor/Media",
        assets: [{ id: "asset-a", mediaId: "media-a", sourceId: "registry-a", name: "A.mov", kind: "video", durationSeconds: 10 }],
        warnings: [],
      },
    });
    expect(() => assertPodcastSetup(value)).toThrow(/portable/i);
  });

  it("rejects a microphone binding to an unknown participant", () => {
    expect(() => assertPodcastSetup(setup({
      participants: [{ id: "host", name: "Host" }],
      analysis: {
        ...setup().analysis,
        assets: [{ ...setup().analysis.assets[0], streams: [{ index: 0, kind: "audio", channels: 1 }] }],
      },
      groups: [{ ...setup().groups[0], audioBindings: [{ assetId: "asset-a", streamIndex: 0, channel: 0, participantId: "guest" }] }],
    }))).toThrow(/participant/i);
  });

  it("rejects an out-of-range source channel binding", () => {
    expect(() => assertPodcastSetup(setup({
      analysis: {
        ...setup().analysis,
        assets: [{ ...setup().analysis.assets[0], streams: [{ index: 0, kind: "audio", channels: 1 }] }],
      },
      groups: [{ ...setup().groups[0], audioBindings: [{ assetId: "asset-a", streamIndex: 0, channel: 1 }] }],
    }))).toThrow(/channel/i);
  });

  it("rejects malformed restored timing and source facts", () => {
    expect(() => assertPodcastSetup(setup({
      analysis: {
        ...setup().analysis,
        assets: [{ ...setup().analysis.assets[0], durationSeconds: -1 }],
      },
      placements: [{ assetId: "asset-a", mapping: { version: 1, scale: 0, offsetSeconds: 0 }, status: "manual", component: "camera-a", locked: false, provenance: [] }],
    }))).toThrow(/source|timing/i);
  });

  it("validates a persisted decode failure against its inventoried audio stream", () => {
    const value = setup({
      analysis: { ...setup().analysis, assets: [{ ...setup().analysis.assets[0], streams: [{ index: 0, kind: "audio", channels: 1 }] }] },
      decodeFailure: { version: 1, id: "failure-a", assetId: "asset-a", sourceId: "registry-a", streamIndex: 0, channelIndex: 0, startSample: 10, requestedSamples: 80_000, validSamples: 79_999, sampleRate: 8_000, reason: "interior-short-read", attempts: 1, evidence: { naturalEof: false, decoderDrained: false, resamplerFlushed: false, startCovered: true, contiguousTimestamps: true, decodeErrors: false } },
    });
    expect(() => assertPodcastSetup(value)).not.toThrow();
    expect(() => assertPodcastSetup({ ...value, decodeFailure: { ...(value as PodcastSetup).decodeFailure!, channelIndex: 1 } })).toThrow(/channel/i);
  });

  it("requires the explicit exclusion to accompany an unresolved decode resolution", () => {
    const value = setup({
      analysis: { ...setup().analysis, assets: [{ ...setup().analysis.assets[0], streams: [{ index: 0, kind: "audio", channels: 1 }] }] },
      decodeFailure: { version: 1, id: "failure-a", assetId: "asset-a", sourceId: "registry-a", streamIndex: 0, channelIndex: 0, startSample: 10, requestedSamples: 80_000, validSamples: 79_999, sampleRate: 8_000, reason: "interior-short-read", attempts: 1, resolution: "unresolved-excluded", evidence: { naturalEof: false, decoderDrained: false, resamplerFlushed: false, startCovered: true, contiguousTimestamps: true, decodeErrors: false } },
      placements: [{ assetId: "asset-a", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, status: "excluded", component: "asset-a", locked: true, provenance: [], exception: "Explicitly excluded after decode failure." }],
    });
    expect(() => assertPodcastSetup(value)).not.toThrow();
    expect(() => assertPodcastSetup({ ...value, placements: [] })).toThrow(/explicit excluded placement/i);
  });
});
