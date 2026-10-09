import { describe, expect, it } from "vitest";
import type { PodcastGroup } from "@licketysplit/core/lickety/podcast-types";
import { excludePodcastAsset, mergePodcastGroups, moveGroupAsset, podcastRecorderTimingLinked, setPodcastRecorderTimingLinked, simultaneousPodcastSuggestions, splitPodcastGroup } from "./podcast-group-edits";

const group = (id: string, assetIds: string[]): PodcastGroup => ({ id, name: id, kind: "video", role: "camera", confidence: "high", assetIds, warnings: [], recordingLink: { id: `link:${id}`, kind: "continuous" } });

describe("podcast physical-group edits", () => {
  it("surfaces metadata-matched recorder files only as a suggestion until explicitly linked", () => {
    const groups: PodcastGroup[] = [
      { ...group("host", ["a"]), kind: "audio", role: "dialogue" },
      { ...group("guest", ["b"]), kind: "audio", role: "dialogue" },
      { ...group("other", ["c"]), kind: "audio", role: "dialogue" },
    ];
    const analysis = { assets: [
      { id: "a", durationSeconds: 30, sampleRate: 48000, bwfTimeReferenceSamples: "96000" },
      { id: "b", durationSeconds: 30, sampleRate: 48000, bwfTimeReferenceSamples: "96000" },
      { id: "c", durationSeconds: 31, sampleRate: 48000, bwfTimeReferenceSamples: "96000" },
    ] } as never;
    const suggestion = simultaneousPodcastSuggestions(analysis, groups);
    expect(suggestion).toEqual([["host", "guest"]]);
    expect(podcastRecorderTimingLinked(groups, suggestion[0])).toBe(false);
    const confirmed = setPodcastRecorderTimingLinked(groups, suggestion[0], true);
    expect(podcastRecorderTimingLinked(confirmed, suggestion[0])).toBe(true);
    expect(confirmed.find((item) => item.id === "other")?.recordingLink).toEqual({ id: "link:other", kind: "continuous" });
    expect(podcastRecorderTimingLinked(setPodcastRecorderTimingLinked(confirmed, suggestion[0], false), suggestion[0])).toBe(false);
  });

  it("reorders files while invalidating a continuous-recording confirmation", () => {
    const input = { ...group("camera", ["a", "b", "c"]), warnings: ["This group changed manually; confirm its order and timing relationship."] };
    const moved = moveGroupAsset(input, 0, 1);
    expect(moved.assetIds).toEqual(["b", "a", "c"]);
    expect(moved.recordingLink).toBeUndefined();
    expect(moved.warnings.filter((warning) => warning.includes("changed manually"))).toHaveLength(1);
  });

  it("splits and merges groups without retaining stale recording links", () => {
    const left = group("left", ["a", "b"]);
    const right = group("right", ["c"]);
    const split = splitPodcastGroup([left], 0, 1, () => "new")!;
    expect(split.map((item) => item.assetIds)).toEqual([["a"], ["b"]]);
    const merged = mergePodcastGroups([left, right], 1, () => "merged")!;
    expect(merged).toHaveLength(1);
    expect(merged[0].assetIds).toEqual(["a", "b", "c"]);
    expect(merged[0].recordingLink).toBeUndefined();
  });

  it("removes only the excluded asset and clears its channel binding", () => {
    const input = { ...group("camera", ["a", "b"]), audioBindings: [{ assetId: "a", streamIndex: 1, channel: 0, participantId: "host" }] };
    const next = excludePodcastAsset([input], 0, "a");
    expect(next[0].assetIds).toEqual(["b"]);
    expect(next[0].audioBindings).toEqual([]);
  });
});
