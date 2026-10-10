import type {AnalysisSamples} from "../../../services/lickety/analysis-audio";
import type {
  Action,
  CameraAngle,
  Clip,
  MediaItem,
  MultiCamGroup,
  MulticamSequenceClip,
  Project,
  SyncResult,
  Track,
  MulticamDriftModel,
  MulticamManifest,
  MulticamManifestConstraints,
  MulticamVadTrack,
  MulticamCalibrationRange,
} from "@licketysplit/core";
import { DEFAULT_MULTICAM_MANIFEST_CONSTRAINTS, fingerprintMulticamManifest, type OrmaArtifact } from "@licketysplit/core";

export interface MulticamSyncAnalysis {
  results: Map<string, SyncResult>;
  drift: Record<string, MulticamDriftModel>;
}

export interface ResolvedMulticamSource {
  angle: CameraAngle;
  clip: Clip;
  media: MediaItem;
  track: Track;
  segments: Array<{ clip: Clip; media: MediaItem; track: Track }>;
}

type PodcastClipTag = {
  setupId?: string;
  groupId?: string;
  role?: string;
  participantId?: string;
  sourceStreamIndex?: number;
  sourceChannelIndex?: number;
};

function podcastClipTag(clip: Clip): PodcastClipTag | undefined {
  const value = clip.metadata?.podcast;
  return value && typeof value === "object" ? value as PodcastClipTag : undefined;
}

export function resolveMulticamSources(
  project: Project,
  group: MultiCamGroup,
): ResolvedMulticamSource[] {
  return group.angles.map((angle) => {
    const segmentRefs = angle.sourceSegments?.length
      ? angle.sourceSegments
      : [{ clipId: angle.clipId, trackId: angle.trackId }];
    const segments = segmentRefs.map((segment) => {
      const track = project.timeline.tracks.find((candidate) =>
        candidate.id === segment.trackId && candidate.clips.some((clip) => clip.id === segment.clipId),
      ) ?? project.timeline.tracks.find((candidate) => candidate.clips.some((clip) => clip.id === segment.clipId));
      const clip = track?.clips.find((candidate) => candidate.id === segment.clipId);
      if (!track || !clip) throw new Error(`${angle.name} source segment ${segment.clipId} is no longer available on the timeline.`);
      const media = project.mediaLibrary.items.find((item) => item.id === clip.mediaId);
      if (!media) throw new Error(`${angle.name} source segment ${segment.clipId} is missing its source media.`);
      return { clip, media, track };
    });
    const preferred = segments.find((entry) => entry.clip.id === angle.clipId) ?? segments[0];
    if (!preferred) throw new Error(`${angle.name} is no longer available on the timeline.`);
    return { angle, ...preferred, segments };
  });
}

export function buildMulticamSourceClipMap(sources: readonly ResolvedMulticamSource[]): Map<string, Clip> {
  return new Map(sources.flatMap((source) => source.segments.map(({ clip }) => [clip.id, clip] as const)));
}

export interface PodcastProgramClipSamples {
  participantId?: string;
  startTime: number;
  duration: number;
  speed: number;
  volume: number;
  samples: Float32Array;
}

/** Map already selected original microphone samples onto their current episode-time clips. */
export function mapPodcastProgramAudio(
  durationSeconds: number,
  sampleRate: number,
  clips: readonly PodcastProgramClipSamples[],
): Array<{ angleId: string; samples: Float32Array; sampleRate: number }> {
  const frameCount = Math.max(0, Math.ceil(durationSeconds * sampleRate));
  const grouped = new Map<string, Float32Array>();
  for (const clip of clips) {
    if (!Number.isFinite(clip.startTime) || clip.startTime < 0 || !Number.isFinite(clip.duration) || clip.duration <= 0 || !Number.isFinite(clip.speed) || clip.speed <= 0) continue;
    if (!Number.isFinite(clip.volume) || clip.volume === 0 || !clip.samples.length) continue;
    const id = clip.participantId ? `participant-${clip.participantId}` : "shared-conversation";
    const output = grouped.get(id) ?? new Float32Array(frameCount);
    grouped.set(id, output);
    const start = Math.max(0, Math.round(clip.startTime * sampleRate));
    const count = Math.min(Math.ceil(clip.duration * sampleRate), output.length - start);
    for (let index = 0; index < count; index++) {
      const sourcePosition = index * clip.speed;
      const left = Math.floor(sourcePosition);
      const fraction = sourcePosition - left;
      const a = clip.samples[left] ?? 0;
      const b = clip.samples[Math.min(left + 1, clip.samples.length - 1)] ?? 0;
      output[start + index] += (a + (b - a) * fraction) * clip.volume;
    }
  }
  return [...grouped].map(([angleId, samples]) => ({ angleId, samples, sampleRate }));
}

export function hasGroupedPodcastSources(group: MultiCamGroup): boolean {
  return group.angles.some((angle) => (angle.sourceSegments?.length ?? 0) > 0);
}

export function prepareMulticamAnalysisAudio(
  buffer: AnalysisSamples,
  targetSampleRate = 2_000,
): { samples: Float32Array; sampleRate: number } {
  const sampleRate = Math.min(buffer.sampleRate, targetSampleRate);
  const samples = new Float32Array(Math.floor(buffer.length * sampleRate / buffer.sampleRate));
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  // Average each source window before downsampling, with one exact rate across cameras.
  for (let index = 0; index < samples.length; index++) {
    const start = Math.floor(index * buffer.sampleRate / sampleRate);
    const end = Math.min(buffer.length, Math.floor((index + 1) * buffer.sampleRate / sampleRate));
    let sum = 0;
    for (const channel of channels) {
      for (let source = start; source < end; source++) sum += channel[source];
    }
    samples[index] = sum / Math.max(1, (end - start) * channels.length);
  }
  return { samples, sampleRate };
}

export function buildMulticamManifest(
  project: Project,
  group: MultiCamGroup,
  sources: readonly ResolvedMulticamSource[],
  constraints: MulticamManifestConstraints,
): MulticamManifest {
  const podcastSetupId = sources.flatMap((source) => source.segments).map(({ clip }) => podcastClipTag(clip)?.setupId).find((id): id is string => typeof id === "string");
  const isPodcast = Boolean(podcastSetupId);
  const audioEntries = podcastSetupId
    ? project.timeline.tracks.flatMap((track) => track.clips.flatMap((clip) => {
        const podcast = podcastClipTag(clip);
        return podcast?.setupId === podcastSetupId && podcast.role === "dialogue"
          ? [{ track, clip, podcast }]
          : [];
      }))
    : [];
  const isolated = new Map<string, { trackIds: Set<string>; bindings: Array<{ trackId: string; streamIndex?: number; channel?: number }>; audioWindows: NonNullable<MulticamManifest["participants"][number]["audioWindows"]> }>();
  const shared = new Map<string, NonNullable<MulticamManifest["participants"][number]["audioWindows"]>>();
  for (const { track, clip, podcast } of audioEntries) {
    const window = {
      trackId: track.id,
      clipId: clip.id,
      mediaId: clip.mediaId,
      startTime: clip.startTime,
      duration: clip.duration,
      inPoint: clip.inPoint,
      outPoint: clip.outPoint,
      speed: clip.speed ?? 1,
      volume: clip.volume ?? 1,
      ...(typeof podcast.sourceChannelIndex === "number" ? { sourceChannelIndex: podcast.sourceChannelIndex } : {}),
    };
    if (podcast.participantId) {
      const entry = isolated.get(podcast.participantId) ?? { trackIds: new Set<string>(), bindings: [], audioWindows: [] };
      entry.trackIds.add(track.id);
      entry.audioWindows.push(window);
      const binding = { trackId: track.id, streamIndex: podcast.sourceStreamIndex as number | undefined, channel: podcast.sourceChannelIndex as number | undefined };
      if (!entry.bindings.some((candidate) => candidate.trackId === binding.trackId && candidate.streamIndex === binding.streamIndex && candidate.channel === binding.channel)) entry.bindings.push(binding);
      isolated.set(podcast.participantId, entry);
    } else {
      const windows = shared.get(track.id) ?? [];
      windows.push(window);
      shared.set(track.id, windows);
    }
  }
  const participants: MulticamManifest["participants"] = isPodcast
    ? [
        ...[...isolated].map(([participantId, audio], index) => ({
          id: `participant-${participantId}`,
          name: project.lickety?.podcastSetup?.participants.find((entry) => entry.id === participantId)?.name ?? participantId,
          audio: [...audio.trackIds][0]!,
          audioTracks: [...audio.trackIds],
          bindings: audio.bindings,
          audioWindows: audio.audioWindows,
          seat: index,
          audioMode: "isolated" as const,
        })),
        ...(shared.size ? [{ id: "shared-conversation", name: "Shared conversation", audio: shared.keys().next().value as string, audioTracks: [...shared.keys()], audioWindows: [...shared.values()].flat(), seat: isolated.size, audioMode: "shared-mix" as const }] : []),
      ]
    : group.angles.filter((angle) => !/\bwide\b/i.test(angle.name)).map((angle, index) => ({
        id: `participant-${angle.id}`,
        name: angle.name,
        audio: angle.id,
        seat: index,
      }));
  const cameras = group.angles.map((angle) => {
    const source = sources.find((entry) => entry.angle.id === angle.id);
    const sourcePodcast = source?.segments.map(({ clip }) => podcastClipTag(clip)).find((podcast) => podcast?.role === "camera" && podcastSetupId === podcast.setupId);
    const podcastGroup = sourcePodcast?.groupId
      ? project.lickety?.podcastSetup?.groups.find((entry) => entry.id === sourcePodcast.groupId)
      : undefined;
    let type: MulticamManifest["cameras"][number]["type"];
    let subject: string;
    if (!isPodcast) {
      type = /\bwide\b/i.test(angle.name) ? "wide" : "closeup";
      subject = type === "wide" ? "all" : `participant-${angle.id}`;
    } else if (podcastGroup?.framing === "everyone") {
      type = "wide";
      subject = "all";
    } else if (podcastGroup?.framing === "person" && podcastGroup.participantIds?.length === 1) {
      const id = `participant-${podcastGroup.participantIds[0]}`;
      if (participants.some((entry) => entry.id === id && entry.audioMode !== "shared-mix")) {
        type = "closeup";
        subject = id;
      } else {
        type = "unknown";
        subject = "unmapped";
      }
    } else {
      type = "unknown";
      subject = "unmapped";
    }
    return {
      id: angle.id,
      type,
      subject,
      file: source?.media.sourceFile?.name ?? source?.media.name ?? angle.name,
      clipId: angle.clipId,
      angleId: angle.id,
      ...(angle.sourceSegments?.length ? { sourceSegments: structuredClone(angle.sourceSegments.map((segment) => {
        const live = source?.segments.find((entry) => entry.clip.id === segment.clipId);
        if (!live) return segment;
        const speed = live.clip.speed ?? 1;
        const liveDuration = Math.max(0, Math.min(live.clip.duration, (live.clip.outPoint - live.clip.inPoint) / speed));
        return { ...segment, mediaId: live.clip.mediaId, trackId: live.track.id, timelineStart: live.clip.startTime, timelineEnd: live.clip.startTime + liveDuration };
      })) } : {}),
    };
  });
  const reference = cameras.find((camera) => camera.type === "wide")?.id ?? (isPodcast ? "" : cameras[0]?.id ?? "");
  return {
    spec: "licketysplit-multicam/v1",
    fps: project.settings.frameRate,
    sync: { method: "audio-crosscorr", reference },
    participants,
    cameras,
    constraints,
  };
}

/** Only reuse grouped-podcast activity while its live camera and microphone routes are unchanged. */
export function hasCurrentGroupedPodcastActivity(
  project: Project,
  group: MultiCamGroup,
  artifact: Pick<OrmaArtifact, "manifestFingerprint">,
): boolean {
  if (!hasGroupedPodcastSources(group)) return true;
  const sources = resolveMulticamSources(project, group);
  const manifest = buildMulticamManifest(project, group, sources, group.manifest?.constraints ?? DEFAULT_MULTICAM_MANIFEST_CONSTRAINTS);
  return artifact.manifestFingerprint === fingerprintMulticamManifest(manifest);
}

export function findMulticamCalibrationRanges(
  tracks: ReadonlyMap<string, MulticamVadTrack>,
  options: { speakingThreshold?: number; quietThreshold?: number; minimumMs?: number } = {},
): {
  ranges: MulticamCalibrationRange[];
  silenceRange?: { startTime: number; endTime: number };
} {
  const speakingThreshold = options.speakingThreshold ?? 0.7;
  const quietThreshold = options.quietThreshold ?? 0.3;
  const minimumMs = options.minimumMs ?? 500;
  const entries = [...tracks.entries()];
  const windowMs = Math.min(...entries.map(([, track]) => track.windowMs));
  if (!entries.length || !Number.isFinite(windowMs)) return { ranges: [] };
  const count = Math.min(
    ...entries.map(([, track]) => Math.floor(track.probabilities.length * track.windowMs / windowMs)),
  );
  const ranges: MulticamCalibrationRange[] = [];
  let silenceStart: number | undefined;
  let silenceRange: { startTime: number; endTime: number } | undefined;
  const activeRuns = new Map<string, number>();
  for (let index = 0; index <= count; index++) {
    const probabilities = new Map(entries.map(([id, track]) => [
      id,
      track.probabilities[Math.floor((index * windowMs) / track.windowMs)] ?? 0,
    ]));
    const alone = entries.find(([id]) =>
      (probabilities.get(id) ?? 0) >= speakingThreshold &&
      entries.every(([other]) => other === id || (probabilities.get(other) ?? 0) <= quietThreshold),
    )?.[0];
    for (const [id] of entries) {
      const start = activeRuns.get(id);
      if (alone === id && start === undefined) activeRuns.set(id, index);
      if (alone !== id && start !== undefined) {
        if ((index - start) * windowMs >= minimumMs) {
          ranges.push({ speakerAngleId: id, startTime: start * windowMs / 1_000, endTime: index * windowMs / 1_000 });
        }
        activeRuns.delete(id);
      }
    }
    const silent = entries.every(([, track]) =>
      (track.probabilities[Math.floor((index * windowMs) / track.windowMs)] ?? 0) <= quietThreshold,
    );
    if (silent && silenceStart === undefined) silenceStart = index;
    if ((!silent || index === count) && silenceStart !== undefined) {
      if (!silenceRange && (index - silenceStart) * windowMs >= minimumMs) {
        silenceRange = { startTime: silenceStart * windowMs / 1_000, endTime: index * windowMs / 1_000 };
      }
      silenceStart = undefined;
    }
  }
  return { ranges, silenceRange };
}

export async function analyzeMulticamSyncInWorker(
  buffers: ReadonlyMap<string, AnalysisSamples>,
  referenceAngleId: string,
): Promise<MulticamSyncAnalysis> {
  const referenceBuffer = buffers.get(referenceAngleId);
  if (!referenceBuffer) throw new Error("The multicam reference audio is missing.");
  const reference = prepareMulticamAnalysisAudio(referenceBuffer, 1_000);
  const results = new Map<string, SyncResult>();
  const drift: Record<string, MulticamDriftModel> = {};
  results.set(referenceAngleId, { offset: 0, confidence: 1, method: "audio" });
  for (const [angleId, buffer] of buffers) {
    if (angleId === referenceAngleId) continue;
    const target = prepareMulticamAnalysisAudio(buffer, 1_000);
    const duration = Math.min(reference.samples.length, target.samples.length) / reference.sampleRate;
    const maxOffsetSeconds = Math.max(0.05, Math.min(30, (duration - 1) / 2));
    const worker = new Worker(
      new URL("../../../workers/multicam-analysis-worker.ts", import.meta.url),
      { type: "module" },
    );
    const requestId = crypto.randomUUID();
    const model = await new Promise<MulticamDriftModel>((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.terminate();
        reject(new Error("Audio synchronization timed out. Try shorter source clips or set offsets manually."));
      }, 60_000);
      worker.onmessage = (event: MessageEvent<{ requestId: string; type: string; model?: MulticamDriftModel; message?: string }>) => {
        if (event.data.requestId !== requestId) return;
        clearTimeout(timeout);
        worker.terminate();
        if (event.data.type === "result" && event.data.model) resolve(event.data.model);
        else reject(new Error(event.data.message ?? "Audio synchronization failed."));
      };
      worker.onerror = (event) => {
        clearTimeout(timeout);
        worker.terminate();
        reject(new Error(event.message || "Audio synchronization worker failed."));
      };
      worker.postMessage({
        requestId,
        type: "drift",
        reference: reference.samples,
        target: target.samples,
        sampleRate: reference.sampleRate,
        options: { blockSeconds: Math.min(5, Math.max(1, duration / 3)), intervalSeconds: 300, maxOffsetSeconds, analysisSampleRate: 400 },
      });
    });
    drift[angleId] = model;
    results.set(angleId, {
      offset: model.interceptSeconds,
      confidence: model.confidence,
      method: model.confidence > 0 ? "audio" : "manual",
    });
  }
  return { results, drift };
}

export function getMulticamAnalysisDuration(
  sources: readonly ResolvedMulticamSource[],
  buffers: ReadonlyMap<string, AnalysisSamples>,
): number {
  if (sources.length === 0) return 0;
  return sources.reduce((duration, source) => {
    const buffer = buffers.get(source.angle.id);
    if (!buffer) return 0;
    const playbackRate = Math.max(0.01, source.clip.speed ?? 1);
    const availableMediaDuration = Math.max(
      0,
      Math.min(buffer.duration, source.clip.outPoint) - source.clip.inPoint - Math.max(0, source.angle.offset),
    ) / playbackRate;
    const alignedDuration = Math.min(source.clip.duration, availableMediaDuration);
    return Math.min(duration, alignedDuration);
  }, Number.POSITIVE_INFINITY);
}

export function updateAlignedSourceOffsets(
  group: MultiCamGroup,
  sources: readonly ResolvedMulticamSource[],
  results: ReadonlyMap<string, SyncResult>,
): void {
  if (hasGroupedPodcastSources(group)) {
    throw new Error("Podcast camera timing is controlled by its approved source placements. Change it in Podcast Setup.");
  }
  const reference = sources[0];
  if (!reference) return;
  for (const source of sources) {
    const result = results.get(source.angle.id);
    if (!result || !Number.isFinite(result.offset) || result.confidence < 0.2 || result.method !== "audio") {
      throw new Error(`Could not reliably sync ${source.angle.name}. Set camera offsets manually or use recordings with shared reference audio.`);
    }
  }
  for (const source of sources) {
    const result = results.get(source.angle.id);
    const angle = group.angles.find((candidate) => candidate.id === source.angle.id);
    if (!result || !angle) continue;
    angle.offset = result.offset + reference.clip.inPoint - source.clip.inPoint;
  }
  // Start where every trimmed source has footage, rather than leaving a gap
  // when a camera needs samples before its selected in point.
  const commonStart = Math.max(0, ...group.angles.map((angle) => -angle.offset));
  if (commonStart > 0) {
    group.syncPoint += commonStart;
    for (const angle of group.angles) angle.offset += commonStart;
  }
}

interface TimelineActionOptions {
  project: Project;
  group: MultiCamGroup;
  groups: MultiCamGroup[];
  outputTrackId: string;
  sequence: readonly MulticamSequenceClip[];
  createId?: () => string;
  now?: () => number;
}

function sourceTrackIdsForGroup(group: MultiCamGroup): string[] {
  return [...new Set(group.angles.flatMap((angle) => [
    angle.trackId,
    ...(angle.sourceSegments ?? []).map((segment) => segment.trackId),
  ]).filter(Boolean))];
}

/**
 * Returns the complete action batch for an automatic edit. Callers wrap the
 * batch in a history group so source-track muting, output replacement, and
 * multicam metadata all undo together.
 */
export function createMulticamTimelineActions({
  project,
  group,
  groups,
  outputTrackId,
  sequence,
  createId = () => crypto.randomUUID(),
  now = () => Date.now(),
}: TimelineActionOptions): Action[] {
  const actions: Action[] = [];
  const action = (type: string, params: Record<string, unknown>): Action => ({
    type,
    id: createId(),
    timestamp: now(),
    params,
  });
  const existingOutputIndex = project.timeline.tracks.findIndex(
    (track) => track.id === outputTrackId,
  );
  if (existingOutputIndex >= 0) {
    actions.push(action("track/remove", { trackId: outputTrackId }));
  }

  const sourceTrackIds = new Set(sourceTrackIdsForGroup(group).filter((trackId) => trackId !== outputTrackId));
  for (const trackId of sourceTrackIds) {
    const track = project.timeline.tracks.find((candidate) => candidate.id === trackId);
    if (!track) continue;
    if (!track.hidden) {
      actions.push(action("track/hide", { trackId, hidden: true }));
    }
    if (!track.muted) {
      actions.push(action("track/mute", { trackId, muted: true }));
    }
  }

  actions.push(
    action("track/add", {
      trackType: "video",
      trackId: outputTrackId,
      position: existingOutputIndex >= 0 ? existingOutputIndex : 0,
    }),
    action("track/rename", {
      trackId: outputTrackId,
      name: `${group.name} Auto Edit`,
    }),
  );
  for (const segment of sequence) {
    actions.push(
      action("clip/add", {
        trackId: outputTrackId,
        mediaId: segment.clip.mediaId,
        startTime: segment.clip.startTime,
        sourceClip: segment.clip,
      }),
    );
  }
  actions.push(action("multicam/setAll", { groups }));
  return actions;
}

export function createMulticamOutputTrack(
  group: MultiCamGroup,
  outputTrackId: string,
  sequence: readonly MulticamSequenceClip[],
): Track {
  return {
    id: outputTrackId,
    type: "video",
    name: `${group.name} Auto Edit`,
    clips: sequence.map((segment) => structuredClone(segment.clip)),
    transitions: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
  };
}

export function createMulticamApplyEditAction({
  project,
  group,
  groups,
  outputTrackId,
  sequence,
  createId = () => crypto.randomUUID(),
  now = () => Date.now(),
}: TimelineActionOptions): Action {
  const existingOutputIndex = project.timeline.tracks.findIndex(
    (track) => track.id === outputTrackId,
  );
  return {
    type: "multicam/applyEdit",
    id: createId(),
    timestamp: now(),
    params: {
      outputTracks: [createMulticamOutputTrack(group, outputTrackId, sequence)],
      replacedOutputTrackIds: previousOutputTrackIds(project, group.id),
      outputTrackPosition: existingOutputIndex >= 0 ? existingOutputIndex : 0,
      sourceTrackIds: sourceTrackIdsForGroup(group).filter((trackId) => trackId !== outputTrackId),
      groups,
    },
  };
}

export function createMulticamApplyTracksAction(input: {
  project: Project;
  group: MultiCamGroup;
  groups: MultiCamGroup[];
  outputTracks: Track[];
  createId?: () => string;
  now?: () => number;
}): Action {
  const outputIds = new Set(input.outputTracks.map((track) => track.id));
  const existingOutputIndex = input.project.timeline.tracks.findIndex((track) =>
    outputIds.has(track.id),
  );
  return {
    type: "multicam/applyEdit",
    id: (input.createId ?? (() => crypto.randomUUID()))(),
    timestamp: (input.now ?? (() => Date.now()))(),
    params: {
      outputTracks: input.outputTracks.map((track) => structuredClone(track)),
      replacedOutputTrackIds: previousOutputTrackIds(input.project, input.group.id),
      outputTrackPosition: existingOutputIndex >= 0 ? existingOutputIndex : 0,
      sourceTrackIds: sourceTrackIdsForGroup(input.group).filter((trackId) => !outputIds.has(trackId)),
      groups: input.groups,
    },
  };
}

function previousOutputTrackIds(project: Project, groupId: string): string[] {
  const group = project.multicamGroups?.find((entry) => entry.id === groupId);
  return group?.outputTrackIds ?? (group?.outputTrackId ? [group.outputTrackId] : []);
}
