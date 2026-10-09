import type { Project, MediaItem } from "../types/project";
import type { Clip, Track } from "../types/timeline";
import { MultiCamEngine, type CameraSourceSegment, type MultiCamGroup } from "../video/multicam-engine";
import { calculateProjectDuration } from "../timeline/project-duration";
import type { PodcastAsset, PodcastGroup, PodcastPlacement, PodcastSetup, PodcastTimeMapping } from "./podcast-types";

export interface PodcastCoverageGap {
  groupId: string;
  startTime: number;
  endTime: number;
}

export interface PodcastAssemblyResult {
  project: Project;
  originShiftSeconds: number;
  coverageGaps: PodcastCoverageGap[];
}

const IDENTITY = {
  position: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  rotation: 0,
  anchor: { x: 0.5, y: 0.5 },
  opacity: 1,
} as const;

const ANGLE_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6"];

interface SourceSlice {
  sourceStart: number;
  sourceEnd: number;
  mapping: PodcastTimeMapping;
  regionId?: string;
  fileStart: number;
  fileEnd: number;
  fileMapping: PodcastTimeMapping;
}

function sourceBounds(asset: PodcastAsset, streamIndex?: number): { start: number; end: number } {
  const containerStart = asset.containerStartSeconds ?? 0;
  const containerEnd = containerStart + asset.durationSeconds;
  const stream = streamIndex === undefined ? undefined : asset.streams?.find((candidate) => candidate.index === streamIndex);
  const start = Math.max(containerStart, stream?.startSeconds ?? containerStart);
  const end = Math.min(containerEnd, stream?.durationSeconds === undefined ? containerEnd : (stream.startSeconds ?? start) + stream.durationSeconds);
  return { start, end };
}

function slicesFor(asset: PodcastAsset, placement: PodcastPlacement, streamIndex?: number): SourceSlice[] {
  if (placement.status === "unresolved") throw new Error(`Place or explicitly exclude ${asset.name} before creating the timeline.`);
  if (placement.status === "excluded") {
    if (!placement.exception?.trim() && !placement.provenance.length) throw new Error(`Add a review note before excluding ${asset.name}.`);
    return [];
  }
  if (placement.status === "manual" && !placement.exception?.trim() && !(placement.regions ?? []).some((region) => region.note?.trim())) {
    throw new Error(`Add a review note for manual placement of ${asset.name}.`);
  }
  const bounds = sourceBounds(asset, streamIndex);
  const assetStart = asset.containerStartSeconds ?? 0;
  const assetEnd = assetStart + asset.durationSeconds;
  const regions = placement.regions?.length ? placement.regions : [{
    id: "full-source",
    sourceStartSeconds: assetStart,
    sourceEndSeconds: assetEnd,
    mapping: placement.mapping,
    status: placement.status === "manual" ? "manual" as const : "measured" as const,
    locked: placement.locked,
    provenance: placement.provenance,
    note: placement.exception,
  }];
  const included: SourceSlice[] = [];
  for (const region of regions) {
    if (region.status === "unresolved") throw new Error(`Review the unresolved region in ${asset.name} before creating the timeline.`);
    if (region.status === "excluded") {
      if (!region.note?.trim()) throw new Error(`Add a review note before excluding a region of ${asset.name}.`);
      continue;
    }
    if (region.status === "manual" && !region.note?.trim() && !placement.exception?.trim()) throw new Error(`Add a review note for the manual region in ${asset.name}.`);
    if (!Number.isFinite(region.sourceStartSeconds) || region.sourceStartSeconds < assetStart || !Number.isFinite(region.sourceEndSeconds) || region.sourceEndSeconds <= region.sourceStartSeconds || region.sourceEndSeconds > assetEnd) {
      throw new Error(`Invalid source interval for ${asset.name}.`);
    }
    if (!Number.isFinite(region.mapping.scale) || region.mapping.scale <= 0 || !Number.isFinite(region.mapping.offsetSeconds)) throw new Error(`Invalid source timing for ${asset.name}.`);
    const sourceStart = Math.max(region.sourceStartSeconds, bounds.start);
    const sourceEnd = Math.min(region.sourceEndSeconds, bounds.end);
    if (sourceEnd <= sourceStart) continue;
    included.push({
      sourceStart,
      sourceEnd,
      mapping: region.mapping,
      regionId: region.id,
      fileStart: sourceStart - (asset.containerStartSeconds ?? 0),
      fileEnd: sourceEnd - (asset.containerStartSeconds ?? 0),
      fileMapping: {
        ...region.mapping,
        offsetSeconds: region.mapping.offsetSeconds + region.mapping.scale * (asset.containerStartSeconds ?? 0),
      },
    });
  }
  return included;
}

function normalizeReferenceClock(slice: SourceSlice, referenceContainerStart: number): SourceSlice {
  return {
    ...slice,
    fileMapping: { ...slice.fileMapping, offsetSeconds: slice.fileMapping.offsetSeconds - referenceContainerStart },
  };
}

function sourceClip(
  setup: PodcastSetup,
  group: PodcastGroup,
  asset: PodcastAsset,
  media: MediaItem,
  slice: SourceSlice,
  originShiftSeconds: number,
  trackId: string,
  kind: "camera" | "dialogue" | "scratch",
  binding?: { streamIndex: number; channel?: number; participantId?: string },
): Clip {
  const speed = 1 / slice.fileMapping.scale;
  const id = `podcast-${setup.setupId}-${group.id}-${asset.id}-${slice.regionId ?? "full"}${binding ? `-${binding.streamIndex}-${binding.channel ?? "mix"}` : ""}`;
  const startTime = slice.fileStart * slice.fileMapping.scale + slice.fileMapping.offsetSeconds + originShiftSeconds;
  const duration = (slice.fileEnd - slice.fileStart) * slice.fileMapping.scale;
  const audioStreams = (asset.streams ?? []).filter((stream) => stream.kind === "audio");
  let audioTrackIndex: number | undefined;
  if (binding) {
    const streamOrdinal = audioStreams.findIndex((stream) => stream.index === binding.streamIndex);
    if (streamOrdinal < 0 && (asset.streams?.length || binding.streamIndex !== 0)) throw new Error(`Audio stream ${binding.streamIndex} is unavailable in ${asset.name}.`);
    audioTrackIndex = streamOrdinal < 0 ? 0 : streamOrdinal;
  }
  return {
    id,
    mediaId: media.id,
    trackId,
    startTime,
    duration,
    inPoint: slice.fileStart,
    outPoint: slice.fileEnd,
    effects: [],
    audioEffects: [],
    transform: { ...IDENTITY, position: { ...IDENTITY.position }, scale: { ...IDENTITY.scale }, anchor: { ...IDENTITY.anchor } },
    volume: kind === "dialogue" ? 1 : 0,
    keyframes: [],
    speed,
    ...(audioTrackIndex === undefined ? {} : { audioTrackIndex }),
    ...(binding?.channel === undefined ? {} : { sourceChannelIndex: binding.channel }),
    metadata: {
      podcast: {
        setupId: setup.setupId,
        groupId: group.id,
        assetId: asset.id,
        sourceId: asset.sourceId,
        role: kind,
        ...(binding?.participantId ? { participantId: binding.participantId } : {}),
        ...(binding ? { sourceStreamIndex: binding.streamIndex } : {}),
        ...(binding?.channel === undefined ? {} : { sourceChannelIndex: binding.channel }),
        regionId: slice.regionId,
        episodeMapping: { ...slice.mapping },
        ...(kind === "camera" ? { mutedScratchAudio: true } : {}),
      },
    },
  };
}

function audioBindings(group: PodcastGroup, asset: PodcastAsset): Array<{ streamIndex: number; channel?: number; participantId?: string }> {
  const configured = (group.audioBindings ?? []).filter((binding) => binding.assetId === asset.id);
  if (group.audioMode === "isolated") {
    if (!configured.length) throw new Error(`Choose a microphone stream and participant for ${asset.name}.`);
    return configured.map((binding) => ({
      streamIndex: binding.streamIndex,
      channel: binding.channel,
      participantId: binding.participantId ?? (group.audioParticipantIds?.length === 1 ? group.audioParticipantIds[0] : undefined),
    }));
  }
  if (configured.length) return configured;
  if (group.audioMode === "shared-mix") {
    const first = asset.streams?.find((stream) => stream.kind === "audio");
    return [{ streamIndex: first?.index ?? 0 }];
  }
  if (group.audioMode === "reference" || group.audioMode === "none") return [];
  throw new Error(`Choose isolated microphones or a shared conversation mix for ${group.name}.`);
}

function sourceStreamIndexes(group: PodcastGroup, asset: PodcastAsset): Array<number | undefined> {
  if (group.role === "camera") return [asset.streams?.find((stream) => stream.kind === "video")?.index];
  if (group.role === "dialogue") return [...new Set(audioBindings(group, asset).map((binding) => binding.streamIndex))];
  if (group.role === "scratch") return [asset.streams?.find((stream) => stream.kind === "audio")?.index];
  return [];
}

function getGapRanges(segments: CameraSourceSegment[], duration: number): Array<{ startTime: number; endTime: number }> {
  const intervals = segments
    .map((segment) => ({ startTime: segment.timelineStart ?? 0, endTime: segment.timelineEnd ?? 0 }))
    .filter((range) => range.endTime > range.startTime)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  const gaps: Array<{ startTime: number; endTime: number }> = [];
  let cursor = 0;
  for (const interval of intervals) {
    if (interval.startTime > cursor + 0.000001) gaps.push({ startTime: cursor, endTime: interval.startTime });
    cursor = Math.max(cursor, interval.endTime);
  }
  if (cursor < duration - 0.000001) gaps.push({ startTime: cursor, endTime: duration });
  return gaps;
}

/** Materialize approved original-source placements while preserving all unrelated project state. */
export function buildPodcastAssembly(
  project: Project,
  setup: PodcastSetup,
  options: { pictureGapPolicy?: "keep-picture-gaps" | "available-camera-fallback" },
): PodcastAssemblyResult {
  if (project.id !== setup.projectId) throw new Error("Podcast setup belongs to a different project.");
  if (setup.state !== "approved") throw new Error("Review and approve the podcast timing before creating its timeline.");
  if (setup.approval?.revision !== setup.revision || !setup.approval.mappingDigest) throw new Error("Approve the current podcast timing revision before creating its timeline.");
  const assetById = new Map(setup.analysis.assets.map((asset) => [asset.id, asset]));
  const referenceContainerStart = (setup.analysis.assets.find((asset) => asset.id === setup.referenceAssetId)?.containerStartSeconds ?? 0);
  const mediaById = new Map(project.mediaLibrary.items.map((item) => [item.id, item]));
  const placementById = new Map(setup.placements.map((placement) => [placement.assetId, placement]));
  const includedSlices = setup.groups.flatMap((group) => group.assetIds.flatMap((assetId) => {
    if (group.role !== "camera" && group.role !== "dialogue" && group.role !== "scratch") return [];
    const asset = assetById.get(assetId);
    const placement = placementById.get(assetId);
    if (!asset || !placement || !mediaById.has(asset.mediaId)) throw new Error(`Relink or place source ${assetId} before creating the timeline.`);
    return sourceStreamIndexes(group, asset).flatMap((streamIndex) => slicesFor(asset, placement, streamIndex).map((slice) => ({
      asset,
      placement,
      slice: normalizeReferenceClock(slice, referenceContainerStart),
      group,
    })));
  }));
  if (!includedSlices.length) throw new Error("The approved setup contains no included original sources.");
  const earliestEpisodeTime = Math.min(...includedSlices.map(({ slice }) => slice.fileStart * slice.fileMapping.scale + slice.fileMapping.offsetSeconds));
  const originShiftSeconds = Math.max(0, -earliestEpisodeTime);
  const generatedTracks: Track[] = [];
  const angleByGroup = new Map<string, MultiCamGroup["angles"][number]>();
  const cameraSegmentsByGroup = new Map<string, CameraSourceSegment[]>();

  for (const group of setup.groups) {
    const sourceAssets = group.assetIds.map((id) => assetById.get(id)!).filter(Boolean);
    if (group.role === "camera" || group.role === "scratch") {
      const segments: CameraSourceSegment[] = [];
      for (const asset of sourceAssets) {
        const media = mediaById.get(asset.mediaId);
        const placement = placementById.get(asset.id);
        if (!media || !placement) throw new Error(`Relink original ${asset.name} before creating the timeline.`);
        const streamIndex = group.role === "camera"
          ? asset.streams?.find((stream) => stream.kind === "video")?.index
          : asset.streams?.find((stream) => stream.kind === "audio")?.index;
        const slices = slicesFor(asset, placement, streamIndex).map((slice) => normalizeReferenceClock(slice, referenceContainerStart));
        if (!slices.length) continue;
        const trackId = `podcast-${setup.setupId}-${group.id}-${asset.id}`;
        const clips = slices.map((slice) => sourceClip(setup, group, asset, media, slice, originShiftSeconds, trackId, group.role === "camera" ? "camera" : "scratch"));
        generatedTracks.push({
          id: trackId,
          type: group.role === "camera" ? "video" : "audio",
          role: group.role === "camera" ? "general" : "effects",
          name: sourceAssets.length > 1 ? `${group.name} · ${asset.name}` : group.name,
          clips,
          transitions: [],
          locked: false,
          hidden: group.role === "camera",
          muted: true,
          solo: false,
          groupId: `podcast-${setup.setupId}-${group.id}`,
        });
        if (group.role === "camera") for (const [index, slice] of slices.entries()) {
          const clip = clips[index]!;
          segments.push({
            mediaId: asset.mediaId,
            clipId: clip.id,
            trackId,
            sourceStartSeconds: slice.sourceStart,
            sourceEndSeconds: slice.sourceEnd,
            episodeMapping: { ...slice.mapping },
            timelineStart: clip.startTime,
            timelineEnd: clip.startTime + clip.duration,
          });
        }
      }
      if (group.role === "camera" && segments.length) {
        cameraSegmentsByGroup.set(group.id, segments);
        const first = segments[0]!;
        angleByGroup.set(group.id, {
          id: `podcast-angle-${setup.setupId}-${group.id}`,
          name: group.name,
          clipId: first.clipId,
          trackId: first.trackId,
          offset: 0,
          color: ANGLE_COLORS[angleByGroup.size % ANGLE_COLORS.length]!,
          isActive: angleByGroup.size === 0,
          sourceSegments: segments,
        });
      }
      continue;
    }
    if (group.role !== "dialogue") continue;
    for (const asset of sourceAssets) {
      const media = mediaById.get(asset.mediaId);
      const placement = placementById.get(asset.id);
      if (!media || !placement) throw new Error(`Relink original ${asset.name} before creating the timeline.`);
      for (const [bindingIndex, binding] of audioBindings(group, asset).entries()) {
        const slices = slicesFor(asset, placement, binding.streamIndex).map((slice) => normalizeReferenceClock(slice, referenceContainerStart));
        const participantId = binding.participantId ?? (group.audioParticipantIds?.length === 1 ? group.audioParticipantIds[0] : undefined);
        if (group.audioMode === "isolated" && !participantId) throw new Error(`Assign ${asset.name} to a participant before creating the timeline.`);
        const trackId = `podcast-${setup.setupId}-${group.id}-${asset.id}-audio-${bindingIndex}`;
        const participantName = participantId
          ? setup.participants.find((participant) => participant.id === participantId)?.name
          : undefined;
        const trackName = participantName && participantName !== group.name
          ? `${group.name} · ${participantName}`
          : group.name;
        generatedTracks.push({
          id: trackId,
          type: "audio",
          role: "dialogue",
          name: trackName,
          clips: slices.map((slice) => sourceClip(setup, group, asset, media, slice, originShiftSeconds, trackId, "dialogue", { ...binding, participantId })),
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
          groupId: `podcast-${setup.setupId}-${group.id}`,
        });
      }
    }
  }

  const duration = Math.max(0, ...generatedTracks.flatMap((track) => track.clips.map((clip) => clip.startTime + clip.duration)));
  const coverageGaps: PodcastCoverageGap[] = [];
  const cameraCoverage = [...angleByGroup.entries()].map(([groupId, angle]) => {
    const groupSegments = cameraSegmentsByGroup.get(groupId) ?? [];
    const gaps = getGapRanges(groupSegments, duration);
    gaps.forEach((gap) => coverageGaps.push({ groupId, ...gap }));
    return { angle: { ...angle, sourceSegments: groupSegments }, gaps };
  });
  const preferredWide = setup.groups.find((group) => group.role === "camera" && group.framing === "everyone" && angleByGroup.has(group.id));
  const preferredAngleId = (preferredWide ? angleByGroup.get(preferredWide.id)?.id : undefined) ?? cameraAnglesFallback(angleByGroup);
  const cameraAngles = cameraCoverage.map(({ angle }) => ({ ...angle, isActive: angle.id === preferredAngleId }));
  if (!cameraAngles.length) throw new Error("The approved setup contains no included camera coverage.");
  if (coverageGaps.length && !options.pictureGapPolicy) throw new Error("Choose whether to keep picture gaps or fall back to another available camera.");

  const groupId = `podcast-${setup.setupId}-camera-group`;
  const outputTrackId = `podcast-${setup.setupId}-program`;
  const multicamGroup: MultiCamGroup = {
    id: groupId,
    name: setup.analysis.projectName,
    angles: cameraAngles,
    activeAngleId: preferredAngleId ?? cameraAngles[0]!.id,
    syncPoint: 0,
    duration,
    createdAt: Date.now(),
    switches: [],
    outputTrackId,
    pictureGapPolicy: options.pictureGapPolicy,
    coverageGaps: cameraCoverage.flatMap(({ angle, gaps }) => gaps.map((gap) => ({ angleId: angle.id, ...gap }))),
  };
  const engine = new MultiCamEngine();
  engine.loadGroups([multicamGroup]);
  const sources = new Map(generatedTracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const)));
  const programClips = engine.buildSequenceClips(groupId, outputTrackId, sources).map(({ clip }) => clip);
  const programTrack: Track = {
    id: outputTrackId,
    type: "video",
    role: "general",
    name: `${setup.analysis.projectName} Program`,
    clips: programClips,
    transitions: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
    groupId: `podcast-${setup.setupId}-program-output`,
  };
  generatedTracks.push(programTrack);

  const previousAssembly = project.lickety?.podcastAssembly;
  const preservedTracks = project.timeline.tracks.filter((track) => !previousAssembly?.ownedTrackIds.includes(track.id));
  const preservedGroups = (project.multicamGroups ?? []).filter((group) => !previousAssembly?.groupIds.includes(group.id));
  const unaffectedDuration = previousAssembly
    ? calculateProjectDuration({ ...project, timeline: { ...project.timeline, tracks: preservedTracks } })
    : project.timeline.duration;
  const ownedTrackIds = generatedTracks.map((track) => track.id);
  const nextProject: Project = {
    ...project,
    modifiedAt: Date.now(),
    timeline: {
      ...project.timeline,
      tracks: [...preservedTracks, ...generatedTracks],
      duration: Math.max(unaffectedDuration, duration),
    },
    multicamGroups: [...preservedGroups, multicamGroup],
    lickety: {
      ...project.lickety,
      schemaVersion: 1,
      podcastSetup: structuredClone(setup),
      podcastAssembly: {
        setupId: setup.setupId,
        setupRevision: setup.revision,
        originShiftSeconds,
        ownedTrackIds,
        groupIds: [groupId],
        pictureGapPolicy: options.pictureGapPolicy,
      },
    },
  };
  return { project: nextProject, originShiftSeconds, coverageGaps };
}

function cameraAnglesFallback(angles: Map<string, MultiCamGroup["angles"][number]>): string | undefined {
  return angles.values().next().value?.id;
}
