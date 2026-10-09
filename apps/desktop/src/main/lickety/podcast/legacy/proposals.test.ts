import { expect, it } from "vitest";
import type { PodcastSetup } from "../../../../../../../packages/core/src/lickety/podcast-types";
import { asSyncProject } from "./approval";
import { applyPodcastUpdate } from "./update";
import { stagePodcastProposal } from "./proposals";

const setupId = "550e8400-e29b-41d4-a716-446655440000";
function fixture(): PodcastSetup {
  const assets = ["a", "b"].map((id) => ({ id, mediaId: `media-${id}`, sourceId: `source-${id}`, name: id, kind: "audio" as const, durationSeconds: 20, streams: [] }));
  const groups = [{ id: "group", name: "mic", kind: "audio" as const, role: "dialogue" as const, confidence: "high" as const, assetIds: ["a", "b"], warnings: [] }];
  return {
    schemaVersion: 1, setupId, projectId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8", revision: 10,
    createdAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z", step: "check",
    analysis: { version: 1, generatedAt: "2026-10-09T00:00:00Z", projectName: "Episode", fps: 30, assets, groups, warnings: [] },
    groups, participants: [], analysisAlgorithm: "legacy", analysisParametersDigest: "params-legacy", referenceAssetId: "a",
    clockGroups: [{ id: "old-clock", assetIds: ["a", "b"], confirmed: true, provenance: "old" }],
    channels: [{ id: "old-channel", assetId: "a", sourceId: "source-a", streamIndex: 0, channel: 0, cacheKey: "old-cache", usable: true, rms: 0.2, sampleRate: 8000, frames: 160_000, timestampStatus: "continuous" }],
    edges: [{ a: "a", b: "b", channelA: "old-channel", channelB: "old-channel", candidates: [], anchors: [], status: "measured", reason: "old evidence" }],
    placements: [{ assetId: "a", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, status: "reference", component: "a", locked: false, provenance: ["old"] }],
    reviewChecks: [{ assetId: "a", channelId: "old-channel", referenceChannelId: "old-channel", projectSeconds: 4, sourceSeconds: 4, referenceSeconds: 4, windowSeconds: 6, fitOverlap: false, score: 1, competingScore: 0, residualMs: 0, status: "pass" }],
    regionEvidence: [], validationReservations: [{ assetId: "a", sourceSeconds: 8, windowSeconds: 6 }],
    state: "approved", approval: { revision: 10, mappingDigest: "old-digest", approvedAt: "2026-10-09T00:00:00Z" },
    transcriptCompatibility: "compatible", warnings: ["old warning"],
  };
}

it("stages all new timing evidence while keeping one coherent prior revision visible, then applies algorithm upgrades atomically", () => {
  const previous = fixture(), result = structuredClone(previous);
  result.analysisAlgorithm = "native-v2"; result.analysisParametersDigest = "params-v2";
  result.referenceAssetId = "b"; result.clockGroups = [{ id: "new-clock", assetIds: ["b"], confirmed: true, provenance: "new" }];
  result.channels = [{ ...result.channels[0], id: "new-channel", assetId: "b", cacheKey: "new-cache" }];
  result.edges = []; result.placements = [{ ...result.placements[0], assetId: "b", status: "reference", component: "b", provenance: ["new"] }];
  result.reviewChecks = []; result.regionEvidence = [{ assetId: "b", role: "fit", channelId: "new-channel", referenceChannelId: "new-channel", sourceSeconds: 3, referenceSeconds: 3, projectSeconds: 3, observedProjectSeconds: 3, windowSeconds: 6, fitOverlap: false, score: 1, competingScore: 0, residualMs: 0, usable: true, subwindows: [] }];
  result.validationReservations = [{ assetId: "b", sourceSeconds: 12, windowSeconds: 6 }]; result.warnings = ["new warning"];
  stagePodcastProposal(result, previous, ["a", "b"]);

  expect(result).toMatchObject({ referenceAssetId: "a", analysisAlgorithm: "legacy", analysisParametersDigest: "params-legacy", state: "review", warnings: ["old warning"] });
  expect(result.channels[0].cacheKey).toBe("old-cache"); expect(result.placements[0].assetId).toBe("a");
  expect(result.reviewChecks?.[0].projectSeconds).toBe(4); expect(result.regionEvidence).toEqual([]);
  expect(result.analysisProposal?.result).toMatchObject({ referenceAssetId: "b", algorithm: "native-v2", parameters: "params-v2", warnings: ["new warning"] });
  expect(result.approval).toBeUndefined();

  const internal = asSyncProject(result);
  applyPodcastUpdate(internal, { setupId, analysisDecision: "apply" });
  expect(internal).toMatchObject({ referenceAssetId: "b", algorithm: "native-v2", parameters: "params-v2", state: "review" });
  expect(internal.placements[0].assetId).toBe("b"); expect(internal.regionEvidence?.[0].sourceSeconds).toBe(3);
});
