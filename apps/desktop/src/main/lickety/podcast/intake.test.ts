import { describe, expect, it } from "vitest";
import { groupPodcastAssets } from "./intake";
import type { PodcastAsset } from "../../../../../../packages/core/src/lickety/podcast-types";
import { parseRate } from "./legacy/time";
import { podcastSequenceMetadata, timecodeFromSampleReference } from "./legacy/intake-metadata";

const asset = (id: string, name: string, extra: Partial<PodcastAsset> = {}): PodcastAsset => ({
  id, mediaId: `media-${id}`, sourceId: `source-${id}`, name, kind: "video", durationSeconds: 60, fps: 30, width: 1920, height: 1080,
  ...extra,
});

describe("legacy-compatible podcast intake grouping", () => {
  it("groups consecutive camera chunks and keeps source order", () => {
    const groups = groupPodcastAssets([asset("b", "Cam_002.mov"), asset("a", "Cam_001.mov")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].assetIds).toEqual(["a", "b"]);
    expect(groups[0]).toMatchObject({ kind: "video", role: "camera", confidence: "medium" });
  });

  it("keeps numbered microphone inputs separate as simultaneous tracks", () => {
    const groups = groupPodcastAssets([
      asset("mic1", "Mic 1.wav", { kind: "audio", fps: 0, width: 0, height: 0, channels: 1 }),
      asset("mic2", "Mic 2.wav", { kind: "audio", fps: 0, width: 0, height: 0, channels: 1 }),
    ]);
    expect(groups.map((group) => group.assetIds)).toEqual([["mic1"], ["mic2"]]);
    expect(groups.map((group) => group.role)).toEqual(["dialogue", "dialogue"]);
  });

  it("splits non-consecutive chunks and reports the physical gap", () => {
    const groups = groupPodcastAssets([asset("a", "Cam_001.mov"), asset("c", "Cam_003.mov")]);
    expect(groups).toHaveLength(2);
    expect(groups.some((group) => group.warnings.some((warning) => /sequence jumps/i.test(warning)))).toBe(true);
  });

  it("preserves legacy C06A duplicate, DJI sequence, and simultaneous-mic grouping", () => {
    const rate = parseRate("24000/1001");
    const assets = [
      asset("c16", "C06A2016.MOV", { durationSeconds: 1.3, sourceTimecodeRate: rate, timecode: "03:28:59:11", creationTime: "2026-09-05T20:28:47Z", ...podcastSequenceMetadata("C06A2016.MOV") }),
      asset("c17", "C06A2017.MOV", { durationSeconds: 1089.1, sourceTimecodeRate: rate, timecode: "03:28:59:11", creationTime: "2026-09-05T20:41:11Z", ...podcastSequenceMetadata("C06A2017.MOV") }),
      asset("c18", "C06A2018.MOV", { durationSeconds: 710, sourceTimecodeRate: rate, timecode: "03:47:07:11", creationTime: "2026-09-05T20:59:21Z", ...podcastSequenceMetadata("C06A2018.MOV") }),
      asset("d12", "DJI_20260905214424_0012_D.MP4", { durationSeconds: 47.1, sourceTimecodeRate: rate, timecode: "05:58:04:03", ...podcastSequenceMetadata("DJI_20260905214424_0012_D.MP4") }),
      asset("d13", "DJI_20260905214515_0013_D.MP4", { durationSeconds: 522.2, sourceTimecodeRate: rate, timecode: "05:58:55:16", ...podcastSequenceMetadata("DJI_20260905214515_0013_D.MP4") }),
      asset("m1", "MIC1.WAV", { kind: "audio", fps: 0, width: 0, height: 0, channels: 1, creationTime: "2020-01-21T10:15:00Z", ...podcastSequenceMetadata("MIC1.WAV") }),
      asset("m2", "MIC2.WAV", { kind: "audio", fps: 0, width: 0, height: 0, channels: 1, creationTime: "2020-01-21T10:15:00Z", ...podcastSequenceMetadata("MIC2.WAV") }),
    ];
    const groups = groupPodcastAssets(assets);
    expect(groups.find((group) => group.assetIds.includes("c16"))?.confidence).toBe("review");
    expect(groups.find((group) => group.assetIds.includes("c17"))?.assetIds).toEqual(["c17", "c18"]);
    expect(groups.find((group) => group.assetIds.includes("d12"))?.assetIds).toEqual(["d12", "d13"]);
    expect(groups.filter((group) => group.assetIds.includes("m1") || group.assetIds.includes("m2"))).toHaveLength(2);
    expect(groups[0].warnings[0]).toContain("same source timecode");
  });

  it("derives BWF timecode from elapsed samples at the actual NTSC rate", () => {
    expect(timecodeFromSampleReference("360605700", 44100, 24000 / 1001)).toBe("02:16:08:20");
  });
});
