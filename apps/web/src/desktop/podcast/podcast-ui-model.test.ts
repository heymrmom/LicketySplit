import { describe, expect, it } from "vitest";
import type { Project } from "@openreel/core";
import type { PodcastSetup } from "@openreel/core/lickety/podcast-types";
import { buildPodcastReviewPoints, getTimelineMediaIds, readPodcastWizardCheckpoint, resolvePodcastPictureGapPolicy, selectablePodcastMedia } from "./podcast-ui-model";
import { createEmptyProject } from "../../stores/project/project-helpers";

describe("podcast UI model", () => {
  it("keeps media usage for hidden and muted clips", () => {
    const project = createEmptyProject("Podcast UI");
    const withClip = {
      ...project,
      timeline: {
        ...project.timeline,
        tracks: [{ id: "source", type: "video" as const, name: "Source", clips: [{ id: "clip", mediaId: "media-a", trackId: "source", startTime: 0, duration: 5, inPoint: 0, outPoint: 5, effects: [], audioEffects: [], transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0, anchor: { x: 0, y: 0 }, opacity: 1 }, volume: 0, keyframes: [] }], transitions: [], locked: false, hidden: true, muted: true, solo: false }],
      },
    } as Project;
    expect(getTimelineMediaIds(withClip)).toEqual(new Set(["media-a"]));
  });

  it("only offers imported video and audio assets for original-source inspection", () => {
    const items = ["video", "audio", "image"].map((type) => ({
      id: type, name: type, type, isPlaceholder: false,
    })) as never[];
    const withPlaceholder = [...items, { id: "missing", name: "missing", type: "audio", isPlaceholder: true }] as never[];
    expect(selectablePodcastMedia(withPlaceholder).map((item) => item.id)).toEqual(["video", "audio"]);
  });

  it("validates a saved picture-gap policy and falls back only to this project's assembly policy", () => {
    const project = createEmptyProject("Podcast UI");
    const saved = {
      ...project,
      lickety: {
        schemaVersion: 1 as const,
        podcastAssembly: { setupId: "setup", setupRevision: 1, originShiftSeconds: 0, ownedTrackIds: [], groupIds: [], pictureGapPolicy: "available-camera-fallback" },
        podcastWizard: { step: "check" as const, selectedMediaIds: [], updatedAt: "now", pictureGapPolicy: "keep-picture-gaps" },
      },
    } as Project;
    expect(resolvePodcastPictureGapPolicy(saved)).toBe("keep-picture-gaps");
    expect(readPodcastWizardCheckpoint(saved)?.pictureGapPolicy).toBe("keep-picture-gaps");

    const savedWizard = (saved as unknown as { lickety: { podcastWizard: Record<string, unknown> } }).lickety.podcastWizard;
    const invalid = {
      ...saved,
      lickety: {
        ...saved.lickety,
        podcastWizard: { ...savedWizard, pictureGapPolicy: "silently-freeze-frame" },
      },
    } as unknown as Project;
    expect(readPodcastWizardCheckpoint(invalid)?.pictureGapPolicy).toBeUndefined();
    expect(resolvePodcastPictureGapPolicy(invalid)).toBe("available-camera-fallback");

    const anotherProject = createEmptyProject("Different project");
    expect(resolvePodcastPictureGapPolicy(anotherProject)).toBeNull();
  });

  it("offers episode checkpoints and every included recording/region boundary", () => {
    const setup = {
      groups: [{ id: "g", name: "Main camera", kind: "video", role: "camera", confidence: "high", assetIds: ["a"], warnings: [] }],
      analysis: { assets: [{ id: "a", name: "Camera A", kind: "video", durationSeconds: 10, containerStartSeconds: 1, streams: [{ index: 0, kind: "video", startSeconds: 1, durationSeconds: 9 }] }] },
      channels: [],
      placements: [{ assetId: "a", status: "manual", mapping: { scale: 1, offsetSeconds: 4 }, regions: [{ id: "r1", sourceStartSeconds: 2, sourceEndSeconds: 6, status: "manual", mapping: { scale: 1, offsetSeconds: 4 }, locked: false, provenance: [] }] }],
    } as unknown as PodcastSetup;
    const points = buildPodcastReviewPoints(setup);
    expect(points.map((point) => point.label)).toEqual(expect.arrayContaining([
      "Episode beginning", "Episode middle", "Episode end", "Camera A start", "Camera A end",
    ]));
    expect(points.find((point) => point.label === "Camera A start")?.projectSeconds).toBe(6);
    expect(points.find((point) => point.label === "Episode beginning")?.projectSeconds).toBe(6);
    expect(points.find((point) => point.label === "Camera A end")?.projectSeconds).toBe(10);
  });

  it("omits excluded regions and uses each included section's own mapping", () => {
    const setup = {
      groups: [{ id: "g", name: "Main camera", kind: "video", role: "camera", confidence: "high", assetIds: ["a"], warnings: [] }],
      analysis: { assets: [{ id: "a", name: "Camera A", kind: "video", durationSeconds: 10, streams: [{ index: 0, kind: "video", startSeconds: 0, durationSeconds: 10 }] }] },
      channels: [],
      placements: [{ assetId: "a", status: "manual", mapping: { scale: 1, offsetSeconds: 2 }, regions: [
        { id: "keep", sourceStartSeconds: 0, sourceEndSeconds: 3, status: "manual", mapping: { scale: 1, offsetSeconds: 2 }, locked: false, provenance: [] },
        { id: "leave", sourceStartSeconds: 5, sourceEndSeconds: 10, status: "excluded", mapping: { scale: 1, offsetSeconds: 8 }, locked: false, provenance: [] },
      ] }],
    } as unknown as PodcastSetup;
    const points = buildPodcastReviewPoints(setup);
    expect(points.filter((point) => point.label.startsWith("Episode ")).map((point) => point.projectSeconds)).toEqual([2, 3.5, 5]);
    expect(points.some((point) => point.projectSeconds === 13)).toBe(false);
  });
});
