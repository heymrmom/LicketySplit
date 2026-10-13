import { createHash } from "node:crypto";
import type { PodcastSetup, PodcastSyncChannel } from "../../../../../../../packages/core/src/lickety/podcast-types";
import type { SyncProject } from "./types";
import { audioTimestampBlockers, regionMappingBlockers, regionStatus, validateRegions } from "./regions";
import { unwaivedTimingBlockers } from "./waivers";

/** The legacy recorder-clock constraint is shared by the native review path. */
export function assertRecorderConstraints(project: Pick<SyncProject, "clockGroups" | "placements">) {
  for (const group of project.clockGroups.filter((item) => item.confirmed && item.sourceStarts)) {
    const rows = project.placements.filter((placement) => group.assetIds.includes(placement.assetId) && placement.status !== "excluded");
    if (rows.length < 2) continue;
    const base = rows[0];
    if (rows.some((placement) => placement.regions ||
      Math.abs(placement.mapping.scale - base.mapping.scale) > 1e-10 ||
      Math.abs(placement.mapping.offsetSeconds - base.mapping.offsetSeconds - base.mapping.scale * (group.sourceStarts![placement.assetId] - group.sourceStarts![base.assetId])) > 1e-7)) {
      throw new Error("These files were confirmed as one recording. Their relative timing must stay together; revise the relationship in Setup before moving them independently.");
    }
  }
}

/** Refresh only native timing facts; Resolve/XML-only rate restrictions do not apply here. */
export function refreshNativeTimingBlockers(project: SyncProject) {
  for (const placement of project.placements) {
    if (placement.regions) regionStatus(placement);
    const retained = (placement.unsupported ?? []).filter((reason) =>
      !/^(Native video rate|Camera clock|Mixed source\/sequence video rates|Timing regions overlap|Timestamp discontinuity requires separate mapping regions|Audio timestamps restart)/.test(reason));
    const channelBlockers = project.channels.filter((channel) => channel.assetId === placement.assetId).flatMap((channel) => {
      const audio = channel.receipt;
      if (!audio) {
        const asset = project.analysis.assets.find((item) => item.id === channel.assetId);
        const stream = asset?.streams?.find((item) => item.index === channel.streamIndex);
        const firstPTSSeconds = channel.firstPTSSeconds ?? stream?.startSeconds ?? asset?.containerStartSeconds ?? 0;
        const frames = channel.frames, sampleRate = channel.sampleRate;
        return audioTimestampBlockers({ version: 1, decoder: "native-window-reader", audioTrackOrdinal: 0,
          channels: stream?.channels ?? Math.max(1, channel.channel + 1), sampleRate,
          nativeSampleRate: stream?.sampleRate ?? sampleRate, firstPTSSeconds, trackStartSeconds: firstPTSSeconds,
          trackDurationSeconds: frames / sampleRate, frames, decodedDurationSeconds: frames / sampleRate,
          discontinuities: structuredClone(channel.discontinuities ?? stream?.discontinuities ?? []) });
      }
      return audioTimestampBlockers({
        version: 1, decoder: audio.decoder, audioTrackOrdinal: audio.audioTrackOrdinal, channels: audio.channels,
        sampleRate: audio.sampleRate, nativeSampleRate: audio.nativeSampleRate, firstPTSSeconds: audio.firstPTSSeconds,
        trackStartSeconds: audio.trackStartSeconds, trackDurationSeconds: audio.trackDurationSeconds,
        frames: audio.frames, decodedDurationSeconds: audio.decodedDurationSeconds, discontinuities: audio.discontinuities,
      });
    });
    placement.unsupported = [...new Set([...retained, ...regionMappingBlockers(placement), ...channelBlockers])];
  }
}

/** Native equivalent of assertSyncApproval, retaining its domain guards and excluding only Resolve adapter checks. */
export function assertNativeSyncApproval(project: SyncProject) {
  assertRecorderConstraints(project);
  assertRecorderClockReview(project);
  if (project.analysisProposal) throw new Error("A pending retry must be reviewed before approval.");
  if (project.state !== "approved" || project.approval?.revision !== project.revision || project.approval.mappingDigest !== nativeMappingDigest(project)) {
    throw new Error("Approve the current synchronization revision before downstream processing.");
  }
  for (const placement of project.placements.filter((item) => item.status !== "excluded")) {
    if (placement.status === "unresolved" || unwaivedTimingBlockers(placement).length || placement.regions?.some((region) => region.status === "unresolved")) {
      throw new Error("Approved synchronization contains an unresolved source, region, or unwaived timing blocker.");
    }
    if (placement.regions) validateRegions(placement.regions);
  }
}

export function nativeMappingDigest(project: SyncProject) {
  const groups = project.groups.map((group) => ({
    id: group.id, kind: group.kind, assetIds: group.assetIds,
    recordingLink: group.recordingLink,
    role: group.role, framing: group.framing, participantIds: group.participantIds,
    audioMode: group.audioMode, audioParticipantIds: group.audioParticipantIds,
    audioBindings: group.audioBindings,
  }));
  const sources = project.channels.map((channel) => [channel.id, channel.cacheKey]);
  const included = new Set(project.groups.flatMap((group) => group.assetIds));
  const sourceIdentities = project.analysis.assets.filter((asset) => included.has(asset.id)).map((asset) => [asset.id, asset.sourceId, asset.sourceDigest]);
  const value = {
    algorithm: project.algorithm, parameters: project.parameters, reference: project.referenceAssetId,
    rate: project.timelineRate, sourceIdentities, sources, groups, clocks: project.clockGroups, placements: project.placements,
  };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function nativeSetupMappingDigest(setup: PodcastSetup) { return nativeMappingDigest(asSyncProject(setup)); }

/** Converts only the relevant native-domain objects to the original project shape for shared guards. */
export function asSyncProject(setup: PodcastSetup): SyncProject {
  const rate = setup.timelineRate ?? { numerator: Math.round(setup.analysis.fps * 1000), denominator: 1000 };
  const referenceAssetId = setup.referenceAssetId ?? setup.placements.find((item) => item.status === "reference")?.assetId ?? setup.groups.flatMap((group) => group.assetIds)[0] ?? "";
  return {
    schemaVersion: 1, algorithm: setup.analysisAlgorithm ?? "", parameters: setup.analysisParametersDigest,
    id: setup.setupId, revision: setup.revision, createdAt: setup.createdAt, updatedAt: setup.updatedAt,
    name: setup.analysis.projectName, analysis: setup.analysis, groups: setup.groups,
    timelineRate: rate, referenceAssetId, clockGroups: structuredClone(setup.clockGroups),
    channels: setup.channels.map((channel) => portableChannelToInternal(channel, setup)), edges: structuredClone(setup.edges), placements: structuredClone(setup.placements),
    reviewChecks: structuredClone(setup.reviewChecks ?? []), regionEvidence: structuredClone(setup.regionEvidence ?? []),
    validationReservations: structuredClone(setup.validationReservations ?? []), state: setup.state,
    approval: structuredClone(setup.approval), transcriptCompatibility: setup.transcriptCompatibility ?? "unbound",
    progress: structuredClone(setup.progress), warnings: [...setup.warnings], metrics: {
      wallSeconds: setup.metrics?.wallSeconds ?? 0, peakRssBytes: setup.metrics?.peakRssBytes ?? 0,
      decodeSeconds: setup.metrics?.decodeSeconds ?? 0, cacheHits: setup.metrics?.cacheHits ?? 0,
      cacheMisses: setup.metrics?.cacheMisses ?? 0,
    },
    analysisProposal: structuredClone(setup.analysisProposal), timingUndo: structuredClone(setup.timingUndo),
    sourceHistory: (setup.sourceHistory ?? []).flatMap((entry) => entry.asset ? [{ revision: entry.revision, reason: entry.reason, asset: entry.asset, placement: entry.placement }] : []),
  };
}

function portableChannelToInternal(channel: PodcastSyncChannel, setup: PodcastSetup): SyncProject["channels"][number] {
  const asset = setup.analysis.assets.find((item) => item.id === channel.assetId);
  const stream = asset?.streams?.find((item) => item.index === channel.streamIndex);
  const audioStreams = (asset?.streams ?? []).filter((item) => item.kind === "audio").sort((a, b) => a.index - b.index);
  const firstPTSSeconds = channel.firstPTSSeconds ?? stream?.startSeconds ?? asset?.containerStartSeconds ?? 0;
  const frames = channel.frames;
  return {
    ...structuredClone(channel),
    audioOrdinal: Math.max(0, audioStreams.findIndex((item) => item.index === channel.streamIndex)),
    featureFile: "", featureCacheKey: channel.cacheKey,
    receipt: {
      version: 1, decoder: "native-window-reader", audioTrackOrdinal: Math.max(0, audioStreams.findIndex((item) => item.index === channel.streamIndex)),
      channels: stream?.channels ?? Math.max(1, channel.channel + 1), sampleRate: channel.sampleRate,
      nativeSampleRate: stream?.sampleRate ?? channel.sampleRate, firstPTSSeconds, trackStartSeconds: firstPTSSeconds,
      trackDurationSeconds: frames / channel.sampleRate, frames, decodedDurationSeconds: frames / channel.sampleRate,
      discontinuities: structuredClone(channel.discontinuities ?? stream?.discontinuities ?? []),
    },
  };
}

export function assertRecorderClockReview(project: SyncProject) {
  for (const group of project.clockGroups.filter((item) => item.confirmed)) {
    const placements = project.placements.filter((item) => group.assetIds.includes(item.assetId) && item.status !== "excluded");
    if (placements.length > 1 && (placements.some((item) => item.regions) || placements.some((item) => Math.abs(item.mapping.scale - placements[0].mapping.scale) > 1e-10))) {
      throw new Error("Confirmed recorder-clock files must share one compatible scale. Resolve conflicting manual rates or clock-group membership before approval.");
    }
  }
}

export function assertNativeApprovalEligible(project: SyncProject) {
  refreshNativeTimingBlockers(project);
  if (project.analysisProposal) throw new Error("Apply or discard the proposed analysis before approving timing.");
  if (project.state !== "review") throw new Error("Complete analysis of the current sources before approving timing.");
  if (!project.placements.length || project.placements.some((placement) => placement.status === "unresolved" || (unwaivedTimingBlockers(placement).length > 0 && placement.status !== "excluded"))) {
    throw new Error("Resolve unresolved sources and unwaived unsupported timing before approving synchronization.");
  }
  if (project.placements.some((placement) => placement.status !== "excluded" && placement.regions?.some((region) => region.status === "unresolved"))) throw new Error("Resolve each unresolved timing region before approval.");
  if (project.placements.some((placement) => placement.status === "manual" && !placement.regions && !placement.exception?.trim())) throw new Error("Manual alignments require an editor note.");
  assertRecorderConstraints(project);
  assertRecorderClockReview(project);
  for (const placement of project.placements.filter((item) => item.status !== "excluded")) if (placement.regions) validateRegions(placement.regions);
}
