export interface RationalRate { numerator: number; denominator: number }

export type PodcastMediaKind = "video" | "audio";
export type PodcastGroupRole = "camera" | "dialogue" | "scratch" | "other";
export type PodcastGroupConfidence = "high" | "medium" | "review";
export type PodcastFraming = "everyone" | "person" | "other";
export type PodcastAudioMode = "isolated" | "shared-mix" | "reference" | "none";
export type PodcastSetupStep = "recordings" | "setup" | "lineup" | "check";
export type PodcastSyncState = "draft" | "analyzing" | "review" | "approved" | "canceled" | "error";
export type PodcastPlacementStatus = "reference" | "measured" | "unresolved" | "manual" | "excluded";
export type PodcastRegionStatus = "measured" | "unresolved" | "manual" | "excluded";

export interface PodcastStreamFacts {
  index: number;
  kind: "video" | "audio" | "data";
  codec?: string;
  timeBase?: RationalRate;
  startSeconds?: number;
  durationSeconds?: number;
  rate?: RationalRate;
  declaredRate?: RationalRate;
  sampleRate?: number;
  channels?: number;
  channelLayout?: string;
  frameCount?: number;
  initialPadding?: number;
  timestampStatus?: "not-scanned" | "continuous" | "discontinuous" | "unsupported" | "unknown";
  discontinuities?: Array<{ atSeconds: number; deltaSeconds: number; decodedFrame: number }>;
}

/** Portable inventory fact. It contains stable app IDs, never local paths. */
export interface PodcastAsset {
  id: string;
  mediaId: string;
  sourceId: string;
  /** SHA-256 identity captured only after this included source is prepared for analysis. */
  sourceDigest?: string;
  name: string;
  kind: PodcastMediaKind;
  durationSeconds: number;
  /** Container presentation origin used to convert packet PTS to file-relative seek offsets. */
  containerStartSeconds?: number;
  frames?: number;
  fps?: number;
  nativeRate?: RationalRate;
  nativeVideoFrames?: number;
  nativeVideoDurationSeconds?: number;
  streams?: PodcastStreamFacts[];
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
  sizeBytes?: number;
  codec?: string;
  creationTime?: string;
  timecode?: string;
  sourceTimecodeRate?: RationalRate;
  timecodeOrigin?: "embedded" | "bwf-derived-label";
  bwfTimeReferenceSamples?: string;
  reel?: string;
  familyKey?: string;
  sequenceNumber?: number;
}

export interface PodcastGroup {
  id: string;
  name: string;
  kind: PodcastMediaKind;
  role: PodcastGroupRole;
  confidence: PodcastGroupConfidence;
  assetIds: string[];
  warnings: string[];
  recordingLink?: { id: string; kind: "simultaneous" | "continuous" };
  framing?: PodcastFraming;
  participantIds?: string[];
  audioMode?: PodcastAudioMode;
  audioParticipantIds?: string[];
  /** Explicit physical input mapping. Omitted channel means the shared stream. */
  audioBindings?: Array<{ assetId: string; streamIndex: number; channel?: number; participantId?: string }>;
}

export interface PodcastParticipant {
  id: string;
  name?: string;
}

export interface PodcastAnalysis {
  version: 1;
  generatedAt: string;
  projectName: string;
  fps: number;
  assets: PodcastAsset[];
  groups: PodcastGroup[];
  warnings: string[];
}

export interface PodcastTimeMapping {
  version: 1;
  scale: number;
  offsetSeconds: number;
}

export interface PodcastSyncChannel {
  id: string;
  assetId: string;
  sourceId: string;
  streamIndex: number;
  channel: number;
  cacheKey: string;
  usable: boolean;
  rms: number;
  sampleRate: number;
  frames: number;
  /** Set only after native packet inspection verifies the asset presentation origin. */
  firstPTSSeconds?: number;
  timestampStatus: "unknown" | "continuous" | "discontinuous" | "unsupported";
  discontinuities?: Array<{ atSeconds: number; deltaSeconds: number; decodedFrame: number }>;
}

export interface PodcastSyncAnchor {
  role: "fit" | "validation";
  sourceSeconds: number;
  referenceSeconds: number;
  score: number;
  competingScore: number;
  polarity: number;
  windowSeconds: number;
  residualMs?: number;
}

export interface PodcastSyncEdge {
  basis?: "waveform" | "recorder";
  a: string;
  b: string;
  channelA: string;
  channelB: string;
  candidates: Array<{ offsetSeconds: number; votes: number; acceptedWindows?: number }>;
  anchors: PodcastSyncAnchor[];
  mapping?: PodcastTimeMapping;
  status: "measured" | "ambiguous" | "unmatched" | "needs-review";
  reason: string;
  maxValidationResidualMs?: number;
  driftPpm?: number;
  overlapSeconds?: number;
  graphResidualMs?: number;
}

export interface PodcastRegion {
  id: string;
  sourceStartSeconds: number;
  sourceEndSeconds: number;
  mapping: PodcastTimeMapping;
  status: PodcastRegionStatus;
  locked: boolean;
  provenance: string[];
  note?: string;
  uncertaintyMs?: number;
}

export interface PodcastPlacement {
  assetId: string;
  mapping: PodcastTimeMapping;
  status: PodcastPlacementStatus;
  component: string;
  locked: boolean;
  provenance: string[];
  uncertaintyMs?: number;
  exception?: string;
  unsupported?: string[];
  regions?: PodcastRegion[];
  reviewReason?: "small-discrepancy" | "conflicting-timing" | "insufficient-evidence";
  humanAcceptance?: { scope: "recording" | "section"; note: string; at: string };
  timingWaiver?: { reasons: string[]; note: string; waivedAt: string };
}

export interface PodcastReviewCheck {
  assetId: string;
  channelId: string;
  referenceChannelId: string;
  projectSeconds: number;
  sourceSeconds: number;
  referenceSeconds: number;
  windowSeconds: number;
  fitOverlap: boolean;
  score: number;
  competingScore: number;
  residualMs: number;
  candidates?: PodcastReviewCandidate[];
  status: "overlaps-training" | "unverified" | "pass" | "failed";
  reason?: string;
}

export interface PodcastReviewCandidate {
  channelId: string;
  referenceChannelId: string;
  sourceSeconds: number;
  referenceSeconds: number;
  fitOverlap: boolean;
  score: number;
  competingScore: number;
  residualMs: number;
  usable: boolean;
  subwindows: Array<{ score: number; competingScore: number; residualMs: number; usable: boolean }>;
}

export interface PodcastRegionEvidence extends PodcastReviewCandidate {
  assetId: string;
  role: "fit" | "validation";
  projectSeconds: number;
  observedProjectSeconds: number;
  windowSeconds: number;
}

export interface PodcastSetupMetrics {
  wallSeconds?: number;
  peakRssBytes?: number;
  decodeSeconds?: number;
  cacheHits?: number;
  cacheMisses?: number;
}

/** A portable checkpoint of timing authority used for retry/apply/discard/undo. */
export interface PodcastTimingSnapshot {
  algorithm?: string;
  parameters?: unknown;
  referenceAssetId?: string;
  clockGroups: Array<{ id: string; assetIds: string[]; confirmed: boolean; provenance: string; sourceStarts?: Record<string, number> }>;
  channels: PodcastSyncChannel[];
  edges: PodcastSyncEdge[];
  placements: PodcastPlacement[];
  reviewChecks?: PodcastReviewCheck[];
  regionEvidence?: PodcastRegionEvidence[];
  validationReservations?: Array<{ assetId: string; sourceSeconds: number; windowSeconds: number }>;
  state: PodcastSyncState;
  warnings: string[];
  metrics?: PodcastSetupMetrics;
}

export interface PodcastAnalysisProposal {
  baseRevision: number;
  result: PodcastTimingSnapshot;
  requestedAssetIds?: string[];
}

export interface PodcastSourceHistoryEntry {
  revision: number;
  reason: string;
  assetId: string;
  asset?: PodcastAsset;
  placement?: PodcastPlacement;
}

export interface PodcastWaveformRequest {
  setupId: string;
  channelId: string;
  startSeconds: number;
  durationSeconds: number;
  maxPoints?: number;
}

export interface PodcastWaveformSummary {
  channelId: string;
  sourceStartSeconds: number;
  durationSeconds: number;
  secondsPerPeak: number;
  min: number[];
  max: number[];
}

/** Persisted, portable setup and review state; analysis caches remain private to main. */
export interface PodcastSetup {
  schemaVersion: 1;
  setupId: string;
  projectId: string;
  revision: number;
  analysisAlgorithm?: string;
  analysisParametersDigest?: string;
  createdAt: string;
  updatedAt: string;
  step: PodcastSetupStep;
  analysis: PodcastAnalysis;
  groups: PodcastGroup[];
  participants: PodcastParticipant[];
  timelineRate?: RationalRate;
  referenceAssetId?: string;
  clockGroups: Array<{ id: string; assetIds: string[]; confirmed: boolean; provenance: string; sourceStarts?: Record<string, number> }>;
  channels: PodcastSyncChannel[];
  edges: PodcastSyncEdge[];
  placements: PodcastPlacement[];
  analysisProposal?: PodcastAnalysisProposal;
  timingUndo?: PodcastTimingSnapshot;
  sourceHistory?: PodcastSourceHistoryEntry[];
  reviewChecks?: PodcastReviewCheck[];
  regionEvidence?: PodcastRegionEvidence[];
  validationReservations?: Array<{ assetId: string; sourceSeconds: number; windowSeconds: number }>;
  state: PodcastSyncState;
  approval?: { revision: number; mappingDigest: string; approvedAt: string };
  transcriptCompatibility?: "unbound" | "compatible" | "stale";
  progress?: { completed: number; total: number; message: string };
  warnings: string[];
  metrics?: PodcastSetupMetrics;
}

export interface PodcastInspectRequest {
  projectId: string;
  mediaIds: string[];
  requestId: string;
  setupId?: string;
}
export interface PodcastReviseRequest {
  setupId: string;
  groups: PodcastGroup[];
  participants: PodcastParticipant[];
}
export interface PodcastAnalyzeRequest { setupId: string; requestId: string; retryAssetIds?: string[]; prepareOnly?: boolean }
export interface PodcastUpdateRequest extends Omit<PodcastPlacementUpdate, "assetId"> {
  setupId: string;
  assetId?: string;
  referenceAssetId?: string;
  clockAssetIds?: string[];
  analysisDecision?: "apply" | "discard";
  undoTiming?: boolean;
}
export interface PodcastPlacementUpdate {
  assetId?: string;
  offsetSeconds?: number;
  scale?: number;
  locked?: boolean;
  excluded?: boolean;
  note?: string;
  regionId?: string;
  splitSourceSeconds?: number;
  waiveUnsupported?: boolean;
  reviewSaved?: boolean;
  acceptTiming?: boolean;
}
export interface PodcastSetupRequest { setupId: string }
export interface PodcastApprovalRequest { setupId: string; expectedRevision: number }
export interface PodcastCancelRequest { requestId: string }
export interface PodcastProgressEvent {
  setupId: string;
  requestId: string;
  phase: "inspect" | "decode" | "features" | "match" | "solve" | "done";
  completed: number;
  total: number;
  message: string;
}

export interface PodcastBridge {
  inspect(args: PodcastInspectRequest): Promise<PodcastSetup>;
  revise(args: PodcastReviseRequest): Promise<PodcastSetup>;
  analyze(args: PodcastAnalyzeRequest): Promise<PodcastSetup>;
  update(args: PodcastUpdateRequest): Promise<PodcastSetup>;
  get(args: PodcastSetupRequest): Promise<PodcastSetup>;
  getWaveform(args: PodcastWaveformRequest): Promise<PodcastWaveformSummary>;
  cancel(args: PodcastCancelRequest): Promise<void>;
  approve(args: PodcastApprovalRequest): Promise<PodcastSetup>;
  onProgress(listener: (event: PodcastProgressEvent) => void): () => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const forbiddenPortableKeys = new Set(["path", "filepath", "pcmpath", "featurepath", "mediaroot", "folder", "originalpath"]);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finiteNonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const finitePositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
function fail(message: string): never { throw new Error(message); }
function assertNoLocalPaths(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) assertNoLocalPaths(item); return; }
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenPortableKeys.has(key.toLowerCase())) throw new Error("Podcast setup is not portable: local file paths are not allowed.");
    assertNoLocalPaths(child);
  }
}

/** Validate restored state before it can be used as an analysis or review authority. */
export function assertPodcastSetup(value: unknown): asserts value is PodcastSetup {
  if (!isRecord(value)) throw new Error("Invalid podcast setup.");
  const setup = value as Partial<PodcastSetup>;
  if (setup.schemaVersion !== 1 || typeof setup.setupId !== "string" || !UUID.test(setup.setupId) || typeof setup.projectId !== "string" || !setup.projectId.trim()) {
    throw new Error("Invalid podcast setup identity.");
  }
  if (!Number.isInteger(setup.revision) || (setup.revision ?? -1) < 0 || !isRecord(setup.analysis) || !Array.isArray(setup.analysis.assets) || !Array.isArray(setup.groups) || !Array.isArray(setup.participants) || !Array.isArray(setup.clockGroups) || !Array.isArray(setup.channels) || !Array.isArray(setup.edges) || !Array.isArray(setup.placements)) {
    throw new Error("Invalid podcast setup state.");
  }
  if (typeof setup.createdAt !== "string" || !Number.isFinite(Date.parse(setup.createdAt)) || typeof setup.updatedAt !== "string" || !Number.isFinite(Date.parse(setup.updatedAt)) || typeof setup.step !== "string" || typeof setup.state !== "string" || !Array.isArray(setup.warnings)) fail("Invalid podcast setup state.");
  if ((setup.analysisAlgorithm !== undefined && typeof setup.analysisAlgorithm !== "string") || (setup.analysisParametersDigest !== undefined && typeof setup.analysisParametersDigest !== "string")) fail("Invalid podcast analysis version.");
  assertNoLocalPaths(value);
  const analysis = setup.analysis as PodcastAnalysis;
  if (analysis.version !== 1 || typeof analysis.generatedAt !== "string" || !Number.isFinite(Date.parse(analysis.generatedAt)) || typeof analysis.projectName !== "string" || !finitePositive(analysis.fps) || !Array.isArray(analysis.groups) || !Array.isArray(analysis.warnings)) fail("Invalid podcast source inventory.");
  const assetById = new Map<string, PodcastAsset>();
  for (const raw of analysis.assets) {
    if (!isRecord(raw)) fail("Invalid podcast source inventory.");
    const asset = raw as unknown as PodcastAsset;
    if (typeof asset.id !== "string" || !asset.id.trim() || typeof asset.mediaId !== "string" || !asset.mediaId.trim() || typeof asset.sourceId !== "string" || !asset.sourceId.trim() || (asset.sourceDigest !== undefined && !/^[a-f0-9]{64}$/i.test(asset.sourceDigest)) || typeof asset.name !== "string" || !["video", "audio"].includes(asset.kind) || !finiteNonnegative(asset.durationSeconds)) fail("Invalid podcast source facts.");
    if (asset.containerStartSeconds !== undefined && !Number.isFinite(asset.containerStartSeconds)) fail("Invalid podcast container presentation origin.");
    if (assetById.has(asset.id)) fail("Podcast inventory has duplicate source IDs.");
    assetById.set(asset.id, asset);
    if (asset.streams !== undefined) {
      if (!Array.isArray(asset.streams)) fail("Invalid podcast stream facts.");
      const streamIndexes = new Set<number>();
      for (const stream of asset.streams) {
        if (!isRecord(stream) || !Number.isInteger(stream.index) || stream.index < 0 || !["video", "audio", "data"].includes(String(stream.kind)) || (stream.channels !== undefined && (!Number.isInteger(stream.channels) || stream.channels < 0))) fail("Invalid podcast stream facts.");
        if (streamIndexes.has(stream.index as number)) fail("Podcast source has duplicate stream indexes.");
        streamIndexes.add(stream.index as number);
      }
    }
  }
  const assets = new Set(assetById.keys());
  const participants = new Set<string>();
  for (const raw of setup.participants) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id.trim() || participants.has(raw.id)) fail("Invalid or duplicate podcast participant.");
    participants.add(raw.id);
  }
  const groupIds = new Set<string>();
  const grouped = new Set<string>();
  for (const raw of setup.groups) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id.trim() || groupIds.has(raw.id) || typeof raw.name !== "string" || !Array.isArray(raw.assetIds) || !Array.isArray(raw.warnings)) fail("Invalid podcast group.");
    groupIds.add(raw.id);
    const group = raw as unknown as PodcastGroup;
    const groupAssets = new Set<string>();
    for (const assetId of group.assetIds) {
      if (typeof assetId !== "string" || !assets.has(assetId)) fail(`Podcast group references unknown source ${String(assetId)}.`);
      if (groupAssets.has(assetId)) fail(`Podcast group contains duplicate source ${assetId}.`);
      if (grouped.has(assetId)) fail(`Podcast source ${assetId} appears in more than one group.`);
      groupAssets.add(assetId); grouped.add(assetId);
    }
    for (const id of [...(group.participantIds ?? []), ...(group.audioParticipantIds ?? [])]) if (!participants.has(id)) fail(`Podcast group references unknown participant ${id}.`);
    for (const binding of group.audioBindings ?? []) {
      if (!isRecord(binding) || typeof binding.assetId !== "string" || !groupAssets.has(binding.assetId) || !Number.isInteger(binding.streamIndex) || binding.streamIndex < 0 || (binding.channel !== undefined && (!Number.isInteger(binding.channel) || binding.channel < 0)) || (binding.participantId !== undefined && !participants.has(binding.participantId))) fail("Invalid podcast audio binding or participant reference.");
      const asset = assetById.get(binding.assetId)!;
      const stream = asset.streams?.find((candidate) => candidate.index === binding.streamIndex);
      if (stream && stream.kind !== "audio") fail("Podcast audio binding references a non-audio stream.");
      if (binding.channel !== undefined && (!stream || !Number.isInteger(stream.channels) || binding.channel >= stream.channels!)) fail("Podcast audio binding channel is outside the source stream.");
    }
  }
  const validatePlacements = (placements: unknown) => {
    if (!Array.isArray(placements)) fail("Invalid podcast timing snapshot.");
    const seen = new Set<string>();
    for (const raw of placements) {
      if (!isRecord(raw) || typeof raw.assetId !== "string" || !assets.has(raw.assetId)) fail(`Podcast placement references unknown source ${String((raw as Record<string, unknown> | null)?.assetId)}.`);
      const placement = raw as unknown as PodcastPlacement;
      if (seen.has(placement.assetId) || !isRecord(placement.mapping) || placement.mapping.version !== 1 || !finitePositive(placement.mapping.scale) || typeof placement.mapping.offsetSeconds !== "number" || !Number.isFinite(placement.mapping.offsetSeconds) || typeof placement.component !== "string" || typeof placement.locked !== "boolean" || !Array.isArray(placement.provenance)) fail("Invalid podcast source timing.");
      seen.add(placement.assetId);
      if (placement.regions !== undefined && !Array.isArray(placement.regions)) fail("Invalid podcast source regions.");
      for (const rawRegion of placement.regions ?? []) {
        if (!isRecord(rawRegion)) fail("Invalid podcast source region.");
        const region = rawRegion as unknown as PodcastRegion;
        if (typeof region.id !== "string" || !finiteNonnegative(region.sourceStartSeconds) || !finitePositive(region.sourceEndSeconds) || region.sourceEndSeconds <= region.sourceStartSeconds || !isRecord(region.mapping) || region.mapping.version !== 1 || !finitePositive(region.mapping.scale) || typeof region.mapping.offsetSeconds !== "number" || !Number.isFinite(region.mapping.offsetSeconds) || typeof region.locked !== "boolean" || !Array.isArray(region.provenance)) fail("Invalid podcast source region.");
      }
    }
  };
  const validateReview = (checks: unknown, regions: unknown, reservations: unknown, channels: unknown) => {
    const channelIds = new Set(Array.isArray(channels) ? channels.filter(isRecord).map((channel) => channel.id).filter((id): id is string => typeof id === "string") : []);
    const validateCandidate = (candidate: unknown) => {
      if (!isRecord(candidate) || typeof candidate.channelId !== "string" || !channelIds.has(candidate.channelId) || typeof candidate.referenceChannelId !== "string" || !channelIds.has(candidate.referenceChannelId) || !finiteNonnegative(candidate.sourceSeconds) || !finiteNonnegative(candidate.referenceSeconds) || typeof candidate.fitOverlap !== "boolean" || typeof candidate.usable !== "boolean" || !Number.isFinite(candidate.score) || !Number.isFinite(candidate.competingScore) || !Number.isFinite(candidate.residualMs) || !Array.isArray(candidate.subwindows)) fail("Invalid podcast independent review candidate.");
    };
    if (checks !== undefined) {
      if (!Array.isArray(checks)) fail("Invalid podcast independent review checks.");
      for (const check of checks) {
        if (!isRecord(check) || typeof check.assetId !== "string" || !assets.has(check.assetId) || typeof check.channelId !== "string" || !channelIds.has(check.channelId) || typeof check.referenceChannelId !== "string" || !channelIds.has(check.referenceChannelId) || !["overlaps-training", "unverified", "pass", "failed"].includes(String(check.status)) || !Number.isFinite(check.projectSeconds) || !Number.isFinite(check.sourceSeconds) || !Number.isFinite(check.referenceSeconds) || !finitePositive(check.windowSeconds) || typeof check.fitOverlap !== "boolean" || !Number.isFinite(check.score) || !Number.isFinite(check.competingScore) || !Number.isFinite(check.residualMs)) fail("Invalid podcast independent review check.");
        if (check.candidates !== undefined && !Array.isArray(check.candidates)) fail("Invalid podcast review alternatives.");
        for (const candidate of check.candidates ?? []) validateCandidate(candidate);
      }
    }
    if (regions !== undefined) {
      if (!Array.isArray(regions)) fail("Invalid podcast regional evidence.");
      for (const region of regions) {
        if (!isRecord(region) || typeof region.assetId !== "string" || !assets.has(region.assetId) || !["fit", "validation"].includes(String(region.role)) || !Number.isFinite(region.projectSeconds) || !Number.isFinite(region.observedProjectSeconds) || !finitePositive(region.windowSeconds)) fail("Invalid podcast regional evidence.");
        validateCandidate(region);
      }
    }
    if (reservations !== undefined) {
      if (!Array.isArray(reservations)) fail("Invalid podcast validation reservations.");
      for (const row of reservations) if (!isRecord(row) || typeof row.assetId !== "string" || !assets.has(row.assetId) || !finiteNonnegative(row.sourceSeconds) || !finitePositive(row.windowSeconds)) fail("Invalid podcast validation reservation.");
    }
  };
  validatePlacements(setup.placements);
  for (const raw of setup.clockGroups) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id.trim() || !Array.isArray(raw.assetIds) || typeof raw.confirmed !== "boolean" || typeof raw.provenance !== "string" || raw.assetIds.length < 1 || raw.assetIds.some((id) => typeof id !== "string" || !assets.has(id)) || new Set(raw.assetIds).size !== raw.assetIds.length) fail("Invalid podcast clock group.");
    if (raw.sourceStarts !== undefined && (!isRecord(raw.sourceStarts) || Object.entries(raw.sourceStarts).some(([id, value]) => !raw.assetIds.includes(id) || !finiteNonnegative(value)))) fail("Invalid podcast clock source starts.");
  }
  for (const raw of setup.channels) {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.assetId !== "string" || !assets.has(raw.assetId) || typeof raw.sourceId !== "string" || !raw.sourceId.trim() || !Number.isInteger(raw.streamIndex) || raw.streamIndex < 0 || !Number.isInteger(raw.channel) || raw.channel < 0 || typeof raw.cacheKey !== "string" || !raw.cacheKey || typeof raw.usable !== "boolean" || !finiteNonnegative(raw.rms) || !finitePositive(raw.sampleRate) || !Number.isInteger(raw.frames) || raw.frames < 0 || !["unknown", "continuous", "discontinuous", "unsupported"].includes(String(raw.timestampStatus)) || (raw.firstPTSSeconds !== undefined && typeof raw.firstPTSSeconds !== "number") || (raw.discontinuities !== undefined && !Array.isArray(raw.discontinuities))) fail("Invalid podcast audio channel facts.");
  }
  for (const raw of setup.edges) if (!isRecord(raw) || typeof raw.a !== "string" || !assets.has(raw.a) || typeof raw.b !== "string" || !assets.has(raw.b) || !Array.isArray(raw.candidates) || !Array.isArray(raw.anchors) || !["measured", "ambiguous", "unmatched", "needs-review"].includes(String(raw.status)) || typeof raw.reason !== "string") fail("Invalid podcast matching evidence.");
  const validateSnapshot = (snapshot: unknown) => {
    if (!isRecord(snapshot) || !Array.isArray(snapshot.clockGroups) || !Array.isArray(snapshot.channels) || !Array.isArray(snapshot.edges) || !Array.isArray(snapshot.warnings)) fail("Invalid podcast timing snapshot.");
    validatePlacements(snapshot.placements);
    validateReview(snapshot.reviewChecks, snapshot.regionEvidence, snapshot.validationReservations, snapshot.channels);
    for (const group of snapshot.clockGroups) if (!isRecord(group) || !Array.isArray(group.assetIds) || group.assetIds.some((id) => typeof id !== "string" || !assets.has(id))) fail("Invalid podcast clock group.");
  };
  if (setup.analysisProposal !== undefined) {
    if (!isRecord(setup.analysisProposal) || !Number.isInteger(setup.analysisProposal.baseRevision) || setup.analysisProposal.baseRevision < 0 || (setup.analysisProposal.requestedAssetIds !== undefined && (!Array.isArray(setup.analysisProposal.requestedAssetIds) || setup.analysisProposal.requestedAssetIds.some((id) => typeof id !== "string" || !assets.has(id))))) fail("Invalid pending podcast analysis proposal.");
    validateSnapshot(setup.analysisProposal.result);
  }
  if (setup.timingUndo !== undefined) validateSnapshot(setup.timingUndo);
  validateReview(setup.reviewChecks, setup.regionEvidence, setup.validationReservations, setup.channels);
  if (setup.sourceHistory !== undefined && (!Array.isArray(setup.sourceHistory) || setup.sourceHistory.some((entry) => !isRecord(entry) || !Number.isInteger(entry.revision) || typeof entry.reason !== "string" || typeof entry.assetId !== "string" || (!assets.has(entry.assetId) && !isRecord(entry.asset)) || (entry.asset !== undefined && (!isRecord(entry.asset) || entry.asset.id !== entry.assetId))))) fail("Invalid podcast source history.");
}
