import { describe, expect, it } from "vitest";
import { makeWorkflowFixture } from "./test-fixtures";
import type { PodcastAsset, PodcastGroup, PodcastPlacement, PodcastSetup } from "./podcast-types";
import { buildPodcastAssembly } from "./podcast-assembly";

const media = [
  { id: "a1", name: "A001.mov", kind: "video" as const, durationSeconds: 1800 },
  { id: "a2", name: "A002.mov", kind: "video" as const, durationSeconds: 1893 },
  { id: "b1", name: "B001.mov", kind: "video" as const, durationSeconds: 3661.75 },
  { id: "c1", name: "C001.mov", kind: "video" as const, durationSeconds: 3693 },
  { id: "mic1", name: "MIC1.wav", kind: "audio" as const, durationSeconds: 3693 },
  { id: "mic2", name: "MIC2.wav", kind: "audio" as const, durationSeconds: 3693 },
];

const assets: PodcastAsset[] = media.map((item) => ({
  ...item,
  mediaId: `media-${item.id}`,
  sourceId: `source-${item.id}`,
  streams: item.id.startsWith("mic")
    ? [
        { index: 0, kind: "data" },
        { index: 2, kind: "audio", channels: 2 },
        { index: 3, kind: "audio", channels: 2 },
      ]
    : [{ index: 0, kind: "video" }, { index: 1, kind: "audio", channels: 2 }],
}));

const groups: PodcastGroup[] = [
  { id: "cam-a", name: "Main", kind: "video", role: "camera", confidence: "high", assetIds: ["a1", "a2"], warnings: [], framing: "everyone", participantIds: ["host"] },
  { id: "cam-b", name: "Host", kind: "video", role: "camera", confidence: "high", assetIds: ["b1"], warnings: [], framing: "person", participantIds: ["host"] },
  { id: "cam-c", name: "Guest", kind: "video", role: "camera", confidence: "high", assetIds: ["c1"], warnings: [], framing: "person", participantIds: ["guest"] },
  { id: "mic-host", name: "Host mic", kind: "audio", role: "dialogue", confidence: "high", assetIds: ["mic1"], warnings: [], audioMode: "isolated", audioParticipantIds: ["host"], audioBindings: [{ assetId: "mic1", streamIndex: 3, channel: 1, participantId: "host" }] },
  { id: "mic-guest", name: "Guest mic", kind: "audio", role: "dialogue", confidence: "high", assetIds: ["mic2"], warnings: [], audioMode: "isolated", audioParticipantIds: ["guest"], audioBindings: [{ assetId: "mic2", streamIndex: 2, channel: 0, participantId: "guest" }] },
];

const placements: PodcastPlacement[] = [
  { assetId: "a1", mapping: { version: 1, scale: 1, offsetSeconds: -12 }, status: "measured", component: "episode", locked: false, provenance: ["sync"] },
  { assetId: "a2", mapping: { version: 1, scale: 1.0001, offsetSeconds: 1788 }, status: "measured", component: "episode", locked: false, provenance: ["drift fit"] },
  { assetId: "b1", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, status: "manual", component: "episode", locked: true, provenance: ["manual placement"], regions: [{ id: "late", sourceStartSeconds: 31.25, sourceEndSeconds: 3661.75, mapping: { version: 1, scale: 1, offsetSeconds: 0 }, status: "manual", locked: true, provenance: ["late start"], note: "Camera started after the opening slate" }] },
  { assetId: "c1", mapping: { version: 1, scale: 1, offsetSeconds: -12 }, status: "measured", component: "episode", locked: false, provenance: ["sync"] },
  { assetId: "mic1", mapping: { version: 1, scale: 1.0001, offsetSeconds: -12 }, status: "measured", component: "episode", locked: false, provenance: ["long-range drift"] },
  { assetId: "mic2", mapping: { version: 1, scale: 1, offsetSeconds: -12 }, status: "measured", component: "episode", locked: false, provenance: ["sync"] },
];

function setup(): PodcastSetup {
  return {
    schemaVersion: 1,
    setupId: "11111111-1111-4111-8111-111111111111",
    projectId: "fixture-project",
    revision: 4,
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z",
    step: "check",
    analysis: { version: 1, generatedAt: "2026-10-09T00:00:00.000Z", projectName: "Episode", fps: 25, assets, groups, warnings: [] },
    groups,
    participants: [{ id: "host", name: "Host" }, { id: "guest", name: "Guest" }],
    clockGroups: [],
    channels: [],
    edges: [],
    placements,
    state: "approved",
    approval: { revision: 4, mappingDigest: "confirmed-mapping-digest", approvedAt: "2026-10-09T00:00:00.000Z" },
    warnings: [],
  };
}

describe("buildPodcastAssembly", () => {
  it("blocks unresolved decode failures and never materializes an explicitly excluded source", () => {
    const source = makeWorkflowFixture({ durationSec: 20 });
    const project = { ...source, mediaLibrary: { items: [...source.mediaLibrary.items, ...media.map((item) => ({ ...source.mediaLibrary.items[0]!, id: `media-${item.id}`, name: item.name, type: item.kind, metadata: { ...source.mediaLibrary.items[0]!.metadata, duration: item.durationSeconds, hasVideo: item.kind === "video", hasAudio: true, audioTrackCount: 2 } }))] } };
    const failed = setup();
    failed.decodeFailure = {
      version: 1, id: "failure-mic2", assetId: "mic2", sourceId: "source-mic2", streamIndex: 2, channelIndex: 0,
      startSample: 10, requestedSamples: 80_000, validSamples: 79_999, sampleRate: 8_000, reason: "interior-short-read", attempts: 1,
      evidence: { naturalEof: false, decoderDrained: false, resamplerFlushed: false, startCovered: true, contiguousTimestamps: true, decodeErrors: false },
    };
    expect(() => buildPodcastAssembly(project, failed, { pictureGapPolicy: "keep-picture-gaps" })).toThrow(/decode failure/i);
    failed.decodeFailure.resolution = "unresolved-excluded";
    const placement = failed.placements.find((row) => row.assetId === "mic2")!;
    placement.status = "excluded"; placement.exception = "Explicitly excluded after decode failure.";
    const assembled = buildPodcastAssembly(project, failed, { pictureGapPolicy: "keep-picture-gaps" });
    expect(assembled.project.timeline.tracks.some((track) => track.clips.some((clip) => clip.mediaId === "media-mic2"))).toBe(false);
  });

  it("materializes three physical cameras and two routed mics on one 61:33 episode clock", () => {
    const source = makeWorkflowFixture({ durationSec: 20 });
    const project = {
      ...source,
      mediaLibrary: {
        items: [...source.mediaLibrary.items, ...media.map((item) => ({
          ...source.mediaLibrary.items[0]!,
          id: `media-${item.id}`,
          name: item.name,
          type: item.kind,
          metadata: {
            ...source.mediaLibrary.items[0]!.metadata,
            duration: item.durationSeconds,
            hasVideo: item.kind === "video",
            hasAudio: true,
            audioTrackCount: 2,
          },
        }))],
      },
    };
    const result = buildPodcastAssembly(project, setup(), { pictureGapPolicy: "keep-picture-gaps" });

    expect(result.originShiftSeconds).toBe(12);
    expect(result.project.timeline.duration).toBeCloseTo(3693.3693, 3);
    expect(result.project.timeline.tracks.filter((track) => ["cam-a", "cam-b", "cam-c"].some((groupId) => track.groupId === `podcast-${setup().setupId}-${groupId}`))).toHaveLength(4);
    expect(result.project.multicamGroups).toHaveLength(1);
    expect(result.project.multicamGroups?.[0]?.angles).toHaveLength(3);
    expect(result.project.multicamGroups?.[0]?.angles[0]?.sourceSegments).toHaveLength(2);
    expect(result.project.multicamGroups?.[0]?.angles[1]?.sourceSegments?.[0]).toMatchObject({
      mediaId: "media-b1",
      sourceStartSeconds: 31.25,
      sourceEndSeconds: 3661.75,
    });
    expect(result.project.timeline.tracks.find((track) => track.name.includes("Host mic"))?.name).toBe("Host mic · Host");
    expect(result.project.timeline.tracks.find((track) => track.name.includes("Host mic"))?.clips[0]).toMatchObject({
      mediaId: "media-mic1",
      startTime: 0,
      inPoint: 0,
      speed: 1 / 1.0001,
      audioTrackIndex: 1,
      sourceChannelIndex: 1,
      volume: 1,
    });
    expect(result.project.timeline.tracks.find((track) => track.name.includes("Main"))?.clips[0]?.volume).toBe(0);
    expect(result.project.timeline.tracks.find((track) => track.name.includes("Main"))?.hidden).toBe(true);
    const program = result.project.timeline.tracks.find((track) => track.id === result.project.multicamGroups?.[0]?.outputTrackId);
    expect(program).toMatchObject({ hidden: false, clips: [expect.objectContaining({ startTime: 0 }), expect.objectContaining({ startTime: 1800 })] });
    expect(result.project.lickety?.podcastSetup).toEqual(setup());
    expect(result.project.lickety?.podcastAssembly?.originShiftSeconds).toBe(12);
    expect(result.coverageGaps.find((gap) => gap.groupId === "cam-b" && gap.startTime === 0)).toBeDefined();
    expect(result.project.timeline.tracks).toContain(source.timeline.tracks[0]);
    expect(result.project.mediaLibrary.items.map((item) => item.id)).toEqual([...source.mediaLibrary.items.map((item) => item.id), ...media.map((item) => `media-${item.id}`)]);
  });

  it("replaces only its own previous tracks and group while keeping unrelated edits", () => {
    const source = makeWorkflowFixture({ durationSec: 20 });
    const project = {
      ...source,
      mediaLibrary: { items: [...source.mediaLibrary.items, ...media.map((item) => ({ ...source.mediaLibrary.items[0]!, id: `media-${item.id}`, type: item.kind, metadata: { ...source.mediaLibrary.items[0]!.metadata, duration: item.durationSeconds, hasVideo: item.kind === "video", hasAudio: true } }))] },
    };
    const first = buildPodcastAssembly(project, setup(), { pictureGapPolicy: "keep-picture-gaps" }).project;
    const manualTrack = { ...source.timeline.tracks[0]!, id: "manual-after-setup", name: "Manual edit" };
    const second = buildPodcastAssembly({ ...first, timeline: { ...first.timeline, tracks: [...first.timeline.tracks, manualTrack] } }, setup(), { pictureGapPolicy: "keep-picture-gaps" }).project;

    expect(second.timeline.tracks.filter((track) => track.groupId?.startsWith("podcast-")).length).toBe(first.lickety?.podcastAssembly?.ownedTrackIds.length);
    expect(second.timeline.tracks.find((track) => track.id === "manual-after-setup")).toEqual(manualTrack);
    expect(second.multicamGroups?.filter((group) => group.id.includes(setup().setupId))).toHaveLength(1);
  });

  it("routes two selected channels from one microphone separately and keeps shared mixes unidentified", () => {
    const source = makeWorkflowFixture();
    const project = { ...source, mediaLibrary: { items: [...source.mediaLibrary.items, ...media.map((item) => ({ ...source.mediaLibrary.items[0]!, id: `media-${item.id}`, type: item.kind, metadata: { ...source.mediaLibrary.items[0]!.metadata, duration: item.durationSeconds, hasVideo: item.kind === "video", hasAudio: true } }))] } };
    const isolated = setup();
    isolated.groups = isolated.groups.map((group) => group.id === "mic-host" ? { ...group, audioParticipantIds: ["host", "guest"], audioBindings: [
      { assetId: "mic1", streamIndex: 3, channel: 0, participantId: "host" },
      { assetId: "mic1", streamIndex: 3, channel: 1, participantId: "guest" },
    ] } : group.id === "mic-guest" ? { ...group, role: "other" } : group);
    isolated.analysis.groups = isolated.groups;
    const separated = buildPodcastAssembly(project, isolated, { pictureGapPolicy: "keep-picture-gaps" }).project.timeline.tracks.filter((track) => track.name.includes("Host mic"));
    expect(separated).toHaveLength(2);
    expect(separated.map((track) => track.clips[0]?.sourceChannelIndex)).toEqual([0, 1]);
    expect(separated.map((track) => track.clips[0]?.metadata?.podcast)).toEqual([
      expect.objectContaining({ participantId: "host" }),
      expect.objectContaining({ participantId: "guest" }),
    ]);

    const shared = { ...isolated, groups: isolated.groups.map((group) => group.id === "mic-host" ? { ...group, audioMode: "shared-mix" as const, audioParticipantIds: undefined, audioBindings: [] } : group) };
    shared.analysis.groups = shared.groups;
    const mix = buildPodcastAssembly(project, shared, { pictureGapPolicy: "keep-picture-gaps" }).project.timeline.tracks.filter((track) => track.name === "Host mic");
    expect(mix).toHaveLength(1);
    expect(mix[0]?.clips[0]).not.toHaveProperty("sourceChannelIndex");
    expect(mix[0]?.clips[0]?.metadata?.podcast).not.toHaveProperty("participantId");
  });

  it("converts raw packet PTS to file-relative source and reference clocks", () => {
    const source = makeWorkflowFixture();
    const project = {
      ...source,
      mediaLibrary: { items: [...source.mediaLibrary.items, ...media.map((item) => ({ ...source.mediaLibrary.items[0]!, id: `media-${item.id}`, type: item.kind, metadata: { ...source.mediaLibrary.items[0]!.metadata, duration: item.durationSeconds, hasVideo: item.kind === "video", hasAudio: true } }))] },
    };
    const adjusted = setup();
    adjusted.referenceAssetId = "a1";
    adjusted.analysis.assets = adjusted.analysis.assets.map((asset) => asset.id === "b1"
      ? { ...asset, containerStartSeconds: 1.5 }
      : asset.id === "mic1"
        ? { ...asset, streams: asset.streams?.map((stream) => stream.index === 3 ? { ...stream, startSeconds: 1.5, durationSeconds: asset.durationSeconds - 1.5 } : stream) }
        : asset);
    adjusted.groups = adjusted.groups.filter((group) => ["cam-a", "cam-b", "mic-host"].includes(group.id)).map((group) => group.id === "cam-a" ? { ...group, assetIds: ["a1"] } : group);
    adjusted.analysis.groups = adjusted.groups;
    adjusted.placements = adjusted.placements.filter((placement) => ["a1", "b1", "mic1"].includes(placement.assetId)).map((placement) => {
      if (placement.assetId === "a1") return { ...placement, mapping: { version: 1, scale: 1, offsetSeconds: 0 } };
      if (placement.assetId === "b1") return { ...placement, mapping: { version: 1, scale: 1, offsetSeconds: -1.5 }, regions: [{ id: "positive-origin", sourceStartSeconds: 1.5, sourceEndSeconds: 100, mapping: { version: 1, scale: 1, offsetSeconds: -1.5 }, status: "measured", locked: false, provenance: ["container-origin"], note: "Container starts after zero" }] };
      if (placement.assetId === "mic1") return { ...placement, mapping: { version: 1, scale: 1, offsetSeconds: 0 }, regions: [{ id: "mixed-stream", sourceStartSeconds: 0, sourceEndSeconds: 100, mapping: { version: 1, scale: 1, offsetSeconds: 0 }, status: "measured", locked: false, provenance: ["audio-packet-offset"] }] };
      return placement;
    });

    const result = buildPodcastAssembly(project, adjusted, { pictureGapPolicy: "keep-picture-gaps" });
    const camera = result.project.timeline.tracks.find((track) => track.groupId === `podcast-${adjusted.setupId}-cam-b`)?.clips[0];
    const mic = result.project.timeline.tracks.find((track) => track.name.includes("Host mic"))?.clips[0];
    const segment = result.project.multicamGroups?.[0]?.angles.find((angle) => angle.name === "Host")?.sourceSegments?.[0] as { sourceStartSeconds?: number; episodeMapping?: { offsetSeconds?: number } } | undefined;
    const podcastMetadata = camera?.metadata?.podcast as { episodeMapping?: { offsetSeconds?: number } } | undefined;

    expect(result.originShiftSeconds).toBe(0);
    expect(camera).toMatchObject({ inPoint: 0, outPoint: 98.5, startTime: 0 });
    expect(podcastMetadata?.episodeMapping).toMatchObject({ offsetSeconds: -1.5 });
    expect(segment).toMatchObject({ sourceStartSeconds: 1.5, episodeMapping: { offsetSeconds: -1.5 } });
    expect(mic).toMatchObject({ inPoint: 1.5, startTime: 1.5, sourceChannelIndex: 1 });
  });
});
