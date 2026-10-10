import { expect, it } from "vitest";
import type { PodcastAnalysis, PodcastAsset, PodcastGroup } from "../../../../../../../packages/core/src/lickety/podcast-types";
import type { SyncProject } from "./types";
import { applyPodcastUpdate } from "./update";
import { PACKET_TIMING_WARNING, unwaivedTimingBlockers } from "./waivers";

const setupId = "550e8400-e29b-41d4-a716-446655440000";
function fixture(): SyncProject {
  const assets = [
    { id: "a", mediaId: "media-a", sourceId: "source-a", name: "First take", kind: "audio", durationSeconds: 30, containerStartSeconds: 2, streams: [{ index: 0, kind: "audio", startSeconds: 2, durationSeconds: 30, timestampStatus: "continuous" }] },
    { id: "b", mediaId: "media-b", sourceId: "source-b", name: "Silent picture", kind: "video", nativeRate: { numerator: 25, denominator: 1 }, durationSeconds: 10, streams: [{ index: 0, kind: "video", startSeconds: -0.02, durationSeconds: 10, timestampStatus: "continuous" }] },
    { id: "c", mediaId: "media-c", sourceId: "source-c", name: "Next take", kind: "audio", durationSeconds: 12, streams: [] },
  ] as unknown as PodcastAsset[];
  const groups = [{ id: "group-a", name: "First take", kind: "audio", role: "dialogue", confidence: "high", assetIds: ["a", "b", "c"], warnings: [] }] as unknown as PodcastGroup[];
  const analysis = { version: 1, generatedAt: "2026-10-09T00:00:00Z", projectName: "Episode", fps: 30, assets, groups, warnings: [] } as PodcastAnalysis;
  return {
    schemaVersion: 1, algorithm: "test", id: setupId, revision: 4, createdAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z",
    name: "Episode", analysis, groups, timelineRate: { numerator: 30000, denominator: 1001 }, referenceAssetId: "a", clockGroups: [], channels: [],
    edges: [], placements: [
      { assetId: "a", status: "reference", mapping: { version: 1, scale: 1.0001, offsetSeconds: 1 }, component: "a", locked: false, provenance: [] },
      { assetId: "b", status: "unresolved", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, component: "b", locked: false, provenance: [] },
    ], state: "approved", approval: { revision: 4, mappingDigest: "old", approvedAt: "2026-10-09T00:00:00Z" },
    transcriptCompatibility: "compatible", warnings: [],
  } as unknown as SyncProject;
}
const update = (fields: Record<string, unknown>) => ({ setupId, ...fields }) as never;

it("matches legacy manual placement revision, provenance, transcript invalidation and review state", () => {
  const project = fixture();
  applyPodcastUpdate(project, update({ assetId: "b", offsetSeconds: 33.0232, note: "Independent B-roll after first take" }));
  expect(project.placements[1]).toMatchObject({ status: "manual", mapping: { scale: 1, offsetSeconds: 33.0232 }, component: "a" });
  expect(project.approval).toBeUndefined(); expect(project.transcriptCompatibility).toBe("stale");
  expect(project.state).toBe("review"); expect(project.revision).toBe(5); expect(project.placements[1].unsupported).toEqual([]);
});

it("requires manual notes and respects placement locks", () => {
  const project = fixture();
  expect(() => applyPodcastUpdate(project, update({ assetId: "b", offsetSeconds: 20 }))).toThrow(/Record why/);
  project.placements[1].locked = true;
  expect(() => applyPodcastUpdate(project, update({ assetId: "b", offsetSeconds: 20, note: "New place" }))).toThrow(/Unlock/);
});

it("preserves accepted packet-warning waiver rules without changing measured mapping", () => {
  const project = fixture(), reference = project.placements[0]; reference.unsupported = [PACKET_TIMING_WARNING];
  applyPodcastUpdate(project, update({ assetId: "a", waiveUnsupported: true, note: "Owner reviewed picture and sound." }));
  expect(reference.mapping).toEqual({ version: 1, scale: 1.0001, offsetSeconds: 1 });
  expect(reference.status).toBe("reference"); expect(reference.timingWaiver?.reasons).toEqual([PACKET_TIMING_WARNING]);
  expect(unwaivedTimingBlockers(reference)).toEqual([]); expect(project.revision).toBe(5); expect(project.approval).toBeUndefined();
});

it("does not waive unresolved placement or adapter capability blockers", () => {
  const project = fixture();
  expect(() => applyPodcastUpdate(project, update({ assetId: "b", waiveUnsupported: true, note: "Accept" }))).toThrow(/no timing warning that can be waived/);
  project.placements[0].unsupported = ["Native video rate is unknown."];
  expect(() => applyPodcastUpdate(project, update({ assetId: "a", waiveUnsupported: true, note: "Accept" }))).toThrow(/no timing warning that can be waived/);
});

it("reopens completed placements after a canceled rerun without changing timing or revision", () => {
  const project = fixture(), before = JSON.stringify(project.placements); project.state = "canceled";
  applyPodcastUpdate(project, update({ reviewSaved: true }));
  expect(project.state).toBe("review"); expect(project.revision).toBe(4); expect(JSON.stringify(project.placements)).toBe(before); expect(project.approval).toBeUndefined();
});

it("rebases review and regional evidence when choosing a new reference clock", () => {
  const project = fixture(), reference = project.placements[1];
  reference.status = "measured"; reference.component = "a"; reference.mapping = { version: 1, scale: 2, offsetSeconds: 10 };
  project.reviewChecks = [{ assetId: "a", channelId: "a:0:0", referenceChannelId: "a:0:0", projectSeconds: 16, sourceSeconds: 1, referenceSeconds: 16, windowSeconds: 6, fitOverlap: false, score: 1, competingScore: 0, residualMs: 0, status: "pass" }];
  project.regionEvidence = [{ assetId: "a", role: "fit", channelId: "a:0:0", referenceChannelId: "a:0:0", sourceSeconds: 1, referenceSeconds: 16, projectSeconds: 16, observedProjectSeconds: 16, windowSeconds: 6, fitOverlap: false, score: 1, competingScore: 0, residualMs: 0, usable: true, subwindows: [] }];
  applyPodcastUpdate(project, update({ referenceAssetId: "b" }));
  expect(project.referenceAssetId).toBe("b"); expect(project.reviewChecks![0].projectSeconds).toBe(3);
  expect(project.regionEvidence![0].projectSeconds).toBe(3); expect(project.regionEvidence![0].observedProjectSeconds).toBe(3);
  expect(project.placements[0].mapping).toEqual({ version: 1, scale: 1.0001 / 2, offsetSeconds: (1 - 10) / 2 });
});

it("splits the raw presented source interval and retains the boundary note", () => {
  const project = fixture();
  applyPodcastUpdate(project, update({ assetId: "a", splitSourceSeconds: 7, note: "Visible clap drift boundary" }));
  expect(project.placements[0].regions).toHaveLength(2);
  expect(project.placements[0].regions).toMatchObject([
    { sourceStartSeconds: 2, sourceEndSeconds: 7, status: "unresolved" },
    { sourceStartSeconds: 7, sourceEndSeconds: 32, status: "unresolved" },
  ]);
  expect(project.placements[0].regions![0].provenance.at(-1)).toContain("Visible clap drift boundary");
});
