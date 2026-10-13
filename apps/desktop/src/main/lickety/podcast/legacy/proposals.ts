import type { PodcastSetup, PodcastTimingSnapshot } from "../../../../../../../packages/core/src/lickety/podcast-types";

export function podcastTimingSnapshot(setup: PodcastSetup): PodcastTimingSnapshot {
  return structuredClone({
    algorithm: setup.analysisAlgorithm, parameters: setup.analysisParametersDigest,
    referenceAssetId: setup.referenceAssetId, clockGroups: setup.clockGroups, channels: setup.channels,
    edges: setup.edges, placements: setup.placements, reviewChecks: setup.reviewChecks,
    regionEvidence: setup.regionEvidence, validationReservations: setup.validationReservations,
    state: setup.state, warnings: setup.warnings, metrics: setup.metrics,
  });
}

function restoreSnapshot(setup: PodcastSetup, snapshot: PodcastTimingSnapshot) {
  setup.analysisAlgorithm = snapshot.algorithm;
  setup.analysisParametersDigest = typeof snapshot.parameters === "string" ? snapshot.parameters : undefined;
  setup.referenceAssetId = snapshot.referenceAssetId;
  setup.clockGroups = structuredClone(snapshot.clockGroups); setup.channels = structuredClone(snapshot.channels);
  setup.edges = structuredClone(snapshot.edges); setup.placements = structuredClone(snapshot.placements);
  setup.reviewChecks = structuredClone(snapshot.reviewChecks); setup.regionEvidence = structuredClone(snapshot.regionEvidence);
  setup.validationReservations = structuredClone(snapshot.validationReservations); setup.state = snapshot.state;
  setup.warnings = structuredClone(snapshot.warnings); setup.metrics = structuredClone(snapshot.metrics);
}

/** Keeps one coherent prior timing authority visible while review stores a separately versioned proposal. */
export function stagePodcastProposal(result: PodcastSetup, previous: PodcastSetup, requestedAssetIds: string[]) {
  const proposal = { baseRevision: previous.revision, requestedAssetIds: [...requestedAssetIds], result: podcastTimingSnapshot(result) };
  restoreSnapshot(result, podcastTimingSnapshot(previous));
  result.analysisProposal = proposal; result.approval = undefined; result.state = "review"; result.progress = undefined;
}
