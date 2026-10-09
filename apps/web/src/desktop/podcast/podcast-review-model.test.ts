// Fixture parity with .superpowers/work/takeover/legacy-baseline/src/sync-review-state.test.ts:
// the indirect b→c overlap anchored at source 20 / reference 220 starts at 217s;
// held-out comparison starts at 27s. The adjacent timeline case also reuses the
// legacy sync-timeline.test.ts 3–13 / 20–23 / 26–29 split-region spans.
import { describe, expect, it } from "vitest";
import type { PodcastAsset, PodcastPlacement, PodcastSetup, PodcastSyncChannel } from "@licketysplit/core/lickety/podcast-types";
import { clipReview, formatReviewTime, parseReviewTime, podcastReviewState, podcastTimelineModel, reviewComparison, timelinePercent, timelineSeconds, timelineWaveformPath, PACKET_TIMING_WARNING } from "./podcast-review-model";

function asset(id: string, name: string, kind: "video" | "audio", durationSeconds = 10): PodcastAsset {
  return {
    id, mediaId: `media-${id}`, sourceId: `source-${id}`, name, kind, durationSeconds,
    channels: kind === "video" ? 1 : 1, sampleRate: 100,
    streams: kind === "video"
      ? [{ index: 0, kind: "video", startSeconds: 0, durationSeconds }, { index: 1, kind: "audio", startSeconds: 0, durationSeconds, sampleRate: 100, channels: 1 }]
      : [{ index: 0, kind: "audio", startSeconds: 0, durationSeconds, sampleRate: 100, channels: 1 }],
  };
}

function channel(assetId: string, streamIndex = 0): PodcastSyncChannel {
  return {
    id: `${assetId}:${streamIndex}:0`, assetId, sourceId: `source-${assetId}`, streamIndex, channel: 0,
    cacheKey: `cache-${assetId}`, usable: true, rms: 0.2, sampleRate: 100, frames: 1000,
    firstPTSSeconds: 0, timestampStatus: "continuous", discontinuities: [],
  };
}

function placement(assetId: string, status: PodcastPlacement["status"] = "measured", offsetSeconds = 0): PodcastPlacement {
  return { assetId, status, mapping: { version: 1, scale: 1, offsetSeconds }, locked: false, component: "test", provenance: [] };
}

function setup(state: PodcastSetup["state"] = "review"): PodcastSetup {
  const assets = [asset("a", "camera.mov", "video"), asset("b", "recorder.wav", "audio"), asset("c", "late-camera.mov", "video")];
  return {
    schemaVersion: 1, setupId: "setup", projectId: "project", revision: 3,
    createdAt: "2026-10-09T12:00:00.000Z", updatedAt: "2026-10-09T12:00:00.000Z", step: "check",
    analysis: { version: 1, generatedAt: "2026-10-09T12:00:00.000Z", projectName: "Synthetic", fps: 24, assets, groups: [], warnings: [] },
    groups: [
      { id: "a-group", name: "Camera", kind: "video", role: "camera", confidence: "high", assetIds: ["a"], warnings: [], audioMode: "reference" },
      { id: "b-group", name: "Recorder", kind: "audio", role: "dialogue", confidence: "high", assetIds: ["b"], warnings: [], audioMode: "isolated" },
      { id: "c-group", name: "Late take", kind: "video", role: "camera", confidence: "high", assetIds: ["c"], warnings: [] },
    ],
    participants: [], clockGroups: [], channels: [channel("a", 1), channel("b"), channel("c", 1)], edges: [],
    placements: [placement("a", "reference"), placement("b")], state, warnings: [],
  };
}

describe("podcast review state adapted from legacy review helpers", () => {
  it.each(["draft", "canceled", "error", "analyzing"] as const)("keeps approval unavailable for %s without placements", (state) => {
    const value = setup(state);
    value.placements = [];
    value.channels = [];
    const view = podcastReviewState(value);
    expect(view.hasResults).toBe(false);
    expect(view.approved).toBe(false);
    expect(view.resumable).toBe(true);
    expect(view.action).not.toBe("Apply as one timeline edit");
  });

  it("distinguishes canceled saved results and only treats current approval revision as approved", () => {
    const value = setup("canceled");
    expect(podcastReviewState(value).message).toContain("prior completed placements");
    expect(podcastReviewState(value).action).toBe("Review saved alignment");
    value.state = "approved";
    value.approval = { revision: 2, mappingDigest: "digest", approvedAt: "now" };
    expect(podcastReviewState(value).approved).toBe(false);
    value.approval.revision = 3;
    expect(podcastReviewState(value).approved).toBe(true);
  });

  it("keeps region and export blockers in the attention queue and honors only a recorded waiver", () => {
    const value = setup();
    value.placements[1].regions = [{ id: "r", sourceStartSeconds: 0, sourceEndSeconds: 3, status: "unresolved", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, locked: false, provenance: [] }];
    const before = JSON.stringify(value);
    expect(podcastReviewState(value).attention.map((item) => item.assetId)).toEqual(["b"]);
    expect(JSON.stringify(value)).toBe(before);
    value.placements[1].regions = undefined;
    value.placements[0].unsupported = [PACKET_TIMING_WARNING];
    expect(clipReview(value.placements[0]).label).toBe("Timing needs attention");
    value.placements[0].timingWaiver = { reasons: [PACKET_TIMING_WARNING], note: "Owner accepted current timing.", waivedAt: "now" };
    expect(clipReview(value.placements[0]).attention).toBe(false);
    value.placements[1].status = "excluded";
    expect(clipReview(value.placements[1]).label).toBe("Left out");
  });

  it("uses held-out checks and connected overlaps without self-comparing", () => {
    const value = setup();
    value.reviewChecks = [{ assetId: "b", channelId: "b:0:0", referenceChannelId: "a:1:0", projectSeconds: 30, sourceSeconds: 40, referenceSeconds: 30, windowSeconds: 6, fitOverlap: false, score: 1, competingScore: 0, residualMs: 0, status: "pass" }];
    expect(reviewComparison(value, "b").start).toBe(27);
    value.reviewChecks = undefined;
    value.placements.push(placement("c", "measured", 200));
    value.edges = [{ a: "b", b: "c", channelA: "b:0:0", channelB: "c:1:0", candidates: [], status: "measured", reason: "fixture", anchors: [{ role: "validation", sourceSeconds: 20, referenceSeconds: 220, score: 1, competingScore: 0, polarity: 1, windowSeconds: 6 }] }];
    expect(reviewComparison(value, "c")).toEqual({ channelA: "b:0:0", channelB: "c:1:0", start: 217, evidence: true });
    value.placements = [placement("a", "reference")];
    value.channels = [channel("a", 1)];
    expect(reviewComparison(value, "a")).toEqual({ channelA: "", channelB: "a:1:0", start: 0, evidence: false });
  });

  it("formats times across hours while retaining subframe mapping precision", () => {
    for (const seconds of [0, 0.000125, 90.461685, 1135, 10 * 3600 + 59.9996]) {
      expect(Math.abs(parseReviewTime(formatReviewTime(seconds)) - seconds)).toBeLessThanOrEqual(0.000501);
    }
    expect(formatReviewTime(1135)).toBe("18:55.000");
    expect(parseReviewTime("2:03:04.125")).toBe(7384.125);
    expect(Number.isNaN(parseReviewTime("not a time"))).toBe(true);
  });
});

describe("podcast timeline adapted from legacy timeline helpers", () => {
  it("shows ordered source lanes before sync without claiming alignment", () => {
    const value = setup("draft");
    value.analysis.assets = [asset("v1", "one.mov", "video", 10), asset("v2", "two.mov", "video", 8)];
    value.groups = [{ id: "camera", name: "Main camera", kind: "video", role: "camera", confidence: "high", assetIds: ["v1", "v2"], warnings: [] }];
    value.channels = [];
    value.placements = [];
    const model = podcastTimelineModel(value);
    expect(model.aligned).toBe(false);
    expect(model.lanes.map((lane) => `${lane.kind}:${lane.label}`)).toEqual(["video:Main camera", "audio:Main camera"]);
    expect(model.lanes[0].clips.map((clip) => [clip.name, clip.startSeconds, clip.status])).toEqual([["one.mov", 0, "not-aligned"], ["two.mov", 10, "not-aligned"]]);
  });

  it("uses saved mappings, gaps, split regions, and attention state", () => {
    const value = setup();
    value.analysis.assets = [asset("v1", "one.mov", "video", 10), asset("v2", "two.mov", "video", 8)];
    value.groups = [{ id: "camera", name: "Main camera", kind: "video", role: "camera", confidence: "high", assetIds: ["v1", "v2"], warnings: [] }];
    value.channels = [channel("v1", 1), channel("v2", 1)];
    value.placements = [
      placement("v1", "reference", 3),
      { ...placement("v2", "unresolved", 20), regions: [
        { id: "a", sourceStartSeconds: 0, sourceEndSeconds: 3, mapping: { version: 1, scale: 1, offsetSeconds: 20 }, status: "measured", locked: false, provenance: [] },
        { id: "b", sourceStartSeconds: 5, sourceEndSeconds: 8, mapping: { version: 1, scale: 1, offsetSeconds: 21 }, status: "unresolved", locked: false, provenance: [] },
      ] },
    ];
    const model = podcastTimelineModel(value);
    expect(model.aligned).toBe(true);
    expect(model.lanes[0].clips.map((clip) => [clip.startSeconds, clip.endSeconds, clip.attention])).toEqual([[3, 13, false], [20, 23, false], [26, 29, true]]);
    expect(timelineSeconds(model, timelinePercent(model, 26))).toBeCloseTo(26, 8);
  });

  it("builds a bounded waveform path from the prepared source summary", () => {
    const channelValue = channel("a");
    const path = timelineWaveformPath({ channelId: channelValue.id, sourceStartSeconds: 0, durationSeconds: 1, secondsPerPeak: 0.01, min: Array(100).fill(-0.5), max: Array(100).fill(0.5) }, channelValue, 0, 1, 40, 20);
    expect(path).toContain("M0,");
    expect(path.split("M")).toHaveLength(41);
  });

  it("removes an attention marker only for a matching saved packet-timing waiver", () => {
    const value = setup();
    value.placements = [{ ...placement("a", "reference"), unsupported: [PACKET_TIMING_WARNING] }];
    expect(podcastTimelineModel(value).lanes[0].clips[0].attention).toBe(true);
    value.placements[0].timingWaiver = { reasons: [PACKET_TIMING_WARNING], note: "Owner accepted current timing.", waivedAt: "now" };
    expect(podcastTimelineModel(value).lanes[0].clips[0].attention).toBe(false);
  });
});
