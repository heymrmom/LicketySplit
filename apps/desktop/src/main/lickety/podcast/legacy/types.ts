import type {
  PodcastAnalysis, PodcastPlacement, PodcastRegion, PodcastRegionEvidence, PodcastReviewCandidate,
  PodcastReviewCheck, PodcastSetupMetrics, PodcastSyncAnchor, PodcastSyncChannel, PodcastSyncEdge,
  PodcastTimeMapping,
} from "../../../../../../../packages/core/src/lickety/podcast-types";

/** Legacy receipt shape without decoder/file paths; samples are read through an injected native window reader. */
export interface DecodeReceipt {
  version: 1;
  decoder: string;
  audioTrackOrdinal: number;
  channels: number;
  sampleRate: number;
  nativeSampleRate: number;
  firstPTSSeconds: number;
  trackStartSeconds: number;
  trackDurationSeconds: number;
  frames: number;
  decodedDurationSeconds: number;
  discontinuities: Array<{ atSeconds: number; deltaSeconds: number; decodedFrame: number }>;
}

export interface SyncChannel extends PodcastSyncChannel {
  receipt: DecodeReceipt;
  audioOrdinal: number;
  featureFile: string;
  featureCacheKey: string;
}
export type SyncAnchor = PodcastSyncAnchor;
export type SyncEdge = PodcastSyncEdge;
export type SyncPlacement = PodcastPlacement;
export type SyncRegion = PodcastRegion;
export type SyncRegionEvidence = PodcastRegionEvidence;
export type SyncReviewCandidate = PodcastReviewCandidate;
export type SyncReviewCheck = PodcastReviewCheck;
export type SyncProgress = { phase: "inspect" | "decode" | "features" | "match" | "solve" | "done"; completed: number; total: number; message: string };

export interface SyncProject {
  schemaVersion: 1;
  algorithm: string;
  parameters?: unknown;
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  name: string;
  analysis: PodcastAnalysis;
  groups: PodcastAnalysis["groups"];
  timelineRate: { numerator: number; denominator: number };
  referenceAssetId: string;
  clockGroups: Array<{ id: string; assetIds: string[]; confirmed: boolean; provenance: string; sourceStarts?: Record<string, number> }>;
  analysisProposal?: { baseRevision: number; result: unknown; requestedAssetIds?: string[] };
  timingUndo?: unknown;
  channels: SyncChannel[];
  edges: SyncEdge[];
  placements: SyncPlacement[];
  reviewChecks?: SyncReviewCheck[];
  regionEvidence?: SyncRegionEvidence[];
  validationReservations?: Array<{ assetId: string; sourceSeconds: number; windowSeconds: number }>;
  state: "draft" | "analyzing" | "review" | "approved" | "canceled" | "error";
  approval?: { revision: number; mappingDigest: string; approvedAt: string };
  transcriptCompatibility: "unbound" | "compatible" | "stale";
  progress?: { completed: number; total: number; message: string };
  warnings: string[];
  metrics?: Required<PodcastSetupMetrics>;
  sourceHistory?: Array<{ revision: number; reason: string; asset: PodcastAnalysis["assets"][number]; placement?: SyncPlacement }>;
}

export type TimeMapping = PodcastTimeMapping;
export type PcmReader = (channel: SyncChannel, sourceStartSeconds: number, durationSeconds: number) => Promise<Float32Array>;
