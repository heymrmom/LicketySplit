import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  PodcastAnalysis, PodcastAnalyzeRecovery, PodcastAsset, PodcastGroup, PodcastParticipant, PodcastSetup, PodcastStreamFacts,
  PodcastUpdateRequest, PodcastWaveformRequest, PodcastWaveformSummary,
} from "../../../../../../packages/core/src/lickety/podcast-types";
import { assertPodcastSetup } from "../../../../../../packages/core/src/lickety/podcast-types";
import { NativeAudioAnalysis, PodcastAudioReadError } from "../audio-analysis";
import { atomicJson } from "../asset-registry";
import { inspectPodcastMedia } from "./native-packet-inspector";
import { groupPodcastAssets } from "./intake";
import { podcastSequenceMetadata, timecodeFromSampleReference } from "./legacy/intake-metadata";
import { analyzeLegacyPodcastSetup as analyzePodcastSetup } from "./legacy/pipeline";
import { applyPodcastUpdate } from "./legacy/update";
import { asSyncProject, assertNativeApprovalEligible, assertNativeSyncApproval, nativeSetupMappingDigest } from "./legacy/approval";
import { revisePodcastSources } from "./legacy/source-revision";
import { stagePodcastProposal } from "./legacy/proposals";
import type { PodcastAssetRegistry, PodcastProgressUpdate } from "./engine";
import { podcastCacheDigest, readPodcastWorkCache } from "./work-cache";
import { ANALYSIS_RATE, HOP } from "./dsp";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface PodcastRegistry extends PodcastAssetRegistry {
  originalUri(mediaId: string): Promise<string | undefined>;
  resolve(assetId: string, purpose: "original"): Promise<{ path: string; mime: string }>;
}
export interface PodcastMediaInspection {
  duration: number; width: number; height: number; frameRate: number; codec: string; sampleRate: number; channels: number; fileSize: number; hasVideo: boolean; hasAudio: boolean;
}
export type PodcastInspectMedia = (sourcePath: string, signal?: AbortSignal) => Promise<{ metadata: PodcastMediaInspection; streams: PodcastStreamFacts[]; containerStartSeconds?: number; sourceMetadata?: { creationTime?: string; timecode?: string; reel?: string; bwfTimeReferenceSamples?: string } }>;
export type PodcastPacketInspect = (sourcePath: string, signal: AbortSignal) => Promise<{ streams: PodcastStreamFacts[]; warnings: string[]; containerStartSeconds?: number }>;
export interface InspectPodcastArgs { projectId: string; mediaIds: string[]; setupId?: string; createSetupId?: string; requestId?: string }
export interface RevisePodcastArgs { setupId: string; groups: PodcastGroup[]; participants: PodcastParticipant[] }

const stableId = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 20);
const now = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const waitTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
function validateSetupId(setupId: string) { if (!UUID.test(setupId)) throw new Error("Invalid podcast setup ID."); }
export class PodcastNativeService {
  private readonly setupDir: string;
  private readonly analysisDir: string;
  private readonly activeSetups = new Set<string>();
  private readonly activeMutations = new Set<string>();
  private readonly activeInspectRequests = new Set<string>();
  constructor(readonly directory: string, private readonly registry: PodcastRegistry, private readonly audio: NativeAudioAnalysis, private readonly inspectMedia: PodcastInspectMedia = async (sourcePath, signal) => {
    const basicFacts = await inspectPodcastMedia(sourcePath, signal ?? new AbortController().signal, { packetScan: false });
    return { metadata: basicFacts.metadata, streams: basicFacts.streams, containerStartSeconds: basicFacts.containerStartSeconds, sourceMetadata: basicFacts.sourceMetadata };
  }, private readonly inspectPackets: PodcastPacketInspect = async (sourcePath, signal) => {
    const packetFacts = await inspectPodcastMedia(sourcePath, signal, { packetScan: true });
    return packetFacts;
  }) {
    this.setupDir = path.join(directory, "setups");
    this.analysisDir = path.join(directory, "analysis");
  }

  private setupPath(setupId: string) { validateSetupId(setupId); return path.join(this.setupDir, `${setupId}.json`); }
  private async save(setup: PodcastSetup) { assertPodcastSetup(setup); await mkdir(this.setupDir, { recursive: true }); await atomicJson(this.setupPath(setup.setupId), setup); }
  private async readSetup(setupId: string): Promise<PodcastSetup> {
    const setup = JSON.parse(await readFile(this.setupPath(setupId), "utf8")) as unknown;
    assertPodcastSetup(setup);
    return clone(setup);
  }
  private async withSetupMutation<T>(setupId: string, work: () => Promise<T>): Promise<T> {
    validateSetupId(setupId);
    if (this.activeSetups.has(setupId)) throw new Error("Wait for or cancel podcast analysis before changing this setup.");
    if (this.activeMutations.has(setupId)) throw new Error("Another podcast setup change is already active.");
    this.activeMutations.add(setupId);
    try { return await work(); }
    finally { this.activeMutations.delete(setupId); }
  }

  private async assertCurrentIncludedSources(setup: PodcastSetup): Promise<void> {
    const included = new Set(setup.groups.flatMap((group) => group.assetIds));
    for (const asset of setup.analysis.assets.filter((candidate) => included.has(candidate.id))) {
      const uri = await this.registry.originalUri(asset.mediaId);
      if (!uri) throw new Error(`${asset.name} has no registered original. Relink it before approving this timing.`);
      let reference: URL;
      try { reference = new URL(uri); } catch { throw new Error(`${asset.name} has an invalid original reference.`); }
      if (reference.protocol !== "licketysplit-media:" || reference.hostname !== asset.sourceId || reference.pathname !== "/original") throw new Error(`${asset.name} was relinked after analysis. Revise Setup and analyze the replacement before approval.`);
      await this.registry.resolve(reference.hostname, "original");
      const current = await this.registry.findMedia(asset.mediaId);
      if (!current || current.identity.assetId !== asset.sourceId || !asset.sourceDigest || current.identity.sha256 !== asset.sourceDigest) throw new Error(`${asset.name} source identity changed after analysis. Revise Setup and analyze the replacement before approval.`);
    }
  }

  async get(setupId: string): Promise<PodcastSetup> {
    const initial = await this.readSetup(setupId);
    if (this.activeMutations.has(setupId) || this.activeSetups.has(setupId)) return initial;
    let needsRepair = initial.state === "analyzing";
    if (initial.state === "approved") {
      try { assertNativeSyncApproval(asSyncProject(initial)); await this.assertCurrentIncludedSources(initial); }
      catch { needsRepair = true; }
    }
    if (!needsRepair) return initial;
    try {
      return await this.withSetupMutation(setupId, async () => {
        const latest = await this.readSetup(setupId);
        if (latest.state === "approved") {
          try { assertNativeSyncApproval(asSyncProject(latest)); await this.assertCurrentIncludedSources(latest); }
          catch {
            latest.state = "draft"; latest.approval = undefined; latest.updatedAt = now();
            latest.warnings.push("Saved approval no longer matches the current source, timing, or review evidence. Review and approve this revision again.");
            await this.save(latest);
          }
        }
        if (latest.state === "analyzing" && !this.activeSetups.has(setupId)) {
          latest.state = "canceled"; latest.progress = undefined;
          latest.warnings.push("Previous native analysis stopped. Completed feature and match caches remain reusable.");
          latest.updatedAt = now(); await this.save(latest);
        }
        return latest;
      });
    } catch (error) {
      if (this.activeSetups.has(setupId) || this.activeMutations.has(setupId)) return this.readSetup(setupId);
      throw error;
    }
  }

  async getWaveform(request: PodcastWaveformRequest): Promise<PodcastWaveformSummary> {
    const setup = await this.get(request.setupId);
    const channel = setup.channels.find((candidate) => candidate.id === request.channelId);
    if (!channel) throw new Error("Podcast waveform channel is unavailable; analyze this setup first.");
    if (!Number.isFinite(request.startSeconds) || !Number.isFinite(request.durationSeconds) || request.durationSeconds <= 0) throw new Error("Invalid podcast waveform range.");
    const maxPoints = request.maxPoints ?? 1600;
    if (!Number.isInteger(maxPoints) || maxPoints < 1 || maxPoints > 20_000) throw new Error("Podcast waveform requests are limited to 20,000 points.");
    const firstPTS = channel.firstPTSSeconds ?? setup.analysis.assets.find((asset) => asset.id === channel.assetId)?.streams?.find((stream) => stream.index === channel.streamIndex)?.startSeconds;
    if (firstPTS === undefined) throw new Error("This channel has no verified waveform origin yet.");
    const identity = { featureCacheKey: channel.cacheKey, frames: channel.frames };
    const cacheKey = podcastCacheDigest({ version: 1, stage: "channel-waveform-v1", identity });
    const file = path.join(this.analysisDir, `${cacheKey}.json`);
    const fileStat = await stat(file).catch(() => undefined);
    if (!fileStat || fileStat.size > 16 * 1024 ** 2) throw new Error("The bounded podcast waveform cache is unavailable; analyze this setup again.");
    const cached = await readPodcastWorkCache<{ version: 1; featureCacheKey: string; frames: number; min: number[]; max: number[] }>(this.analysisDir, cacheKey, (value): value is { version: 1; featureCacheKey: string; frames: number; min: number[]; max: number[] } => {
      if (!value || typeof value !== "object") return false;
      const row = value as { version?: number; featureCacheKey?: string; frames?: number; min?: unknown; max?: unknown };
      return row.version === 1 && row.featureCacheKey === channel.cacheKey && row.frames === channel.frames && Array.isArray(row.min) && Array.isArray(row.max) && row.min.length === Math.floor(channel.frames / HOP) && row.max.length === row.min.length && row.min.every(Number.isFinite) && row.max.every(Number.isFinite);
    });
    if (!cached) throw new Error("The podcast waveform cache failed its integrity check; analyze this setup again.");
    const peaks = HOP / ANALYSIS_RATE, from = Math.max(0, Math.floor((request.startSeconds - firstPTS) / peaks));
    const to = Math.min(Math.floor(cached.frames / HOP), Math.ceil((request.startSeconds + request.durationSeconds - firstPTS) / peaks));
    if (to <= from) throw new Error("Podcast waveform range is outside the analyzed source.");
    const bucketCount = Math.min(maxPoints, to - from), min: number[] = [], max: number[] = [];
    for (let bucket = 0; bucket < bucketCount; bucket++) {
      const begin = from + Math.floor(bucket * (to - from) / bucketCount), end = from + Math.floor((bucket + 1) * (to - from) / bucketCount);
      let low = 1, high = -1;
      for (let index = begin; index < Math.max(begin + 1, end); index++) { low = Math.min(low, cached.min[index] ?? 0); high = Math.max(high, cached.max[index] ?? 0); }
      min.push(low); max.push(high);
    }
    return { channelId: channel.id, sourceStartSeconds: firstPTS + from * peaks, durationSeconds: (to - from) * peaks, secondsPerPeak: ((to - from) * peaks) / bucketCount, min, max };
  }

  async inspect(args: InspectPodcastArgs, signal = new AbortController().signal, onProgress: (event: PodcastProgressUpdate) => void = () => undefined): Promise<PodcastSetup> {
    const requestId = args.requestId ?? randomUUID();
    if (!UUID.test(requestId)) throw new Error("Invalid podcast inspection request ID.");
    if (this.activeInspectRequests.has(requestId)) throw new Error("Podcast inspection request is already active.");
    this.activeInspectRequests.add(requestId);
    try {
      const operation = () => this.inspectOwned({ ...args, requestId }, signal, onProgress);
      return args.setupId ? await this.withSetupMutation(args.setupId, operation) : await operation();
    }
    finally { this.activeInspectRequests.delete(requestId); }
  }

  private async inspectOwned(args: InspectPodcastArgs, signal: AbortSignal, onProgress: (event: PodcastProgressUpdate) => void): Promise<PodcastSetup> {
    if (!args.projectId.trim() || !Array.isArray(args.mediaIds) || args.mediaIds.length === 0 || args.mediaIds.some((id) => typeof id !== "string" || !id.trim()) || new Set(args.mediaIds).size !== args.mediaIds.length) throw new Error("Choose registered recordings to inspect.");
    if (args.setupId && this.activeSetups.has(args.setupId)) throw new Error("Wait for or cancel podcast analysis before changing Setup.");
    let previous: PodcastSetup | undefined;
    if (args.setupId) {
      previous = await this.readSetup(args.setupId);
      if (previous.projectId !== args.projectId) throw new Error("Podcast setup belongs to a different project.");
      if (previous.analysisProposal) throw new Error("Apply or discard the pending timing proposal before changing Setup.");
    }
    const previousAssets = new Map(previous?.analysis.assets.map((asset) => [asset.mediaId, asset]) ?? []);
    const updatedAssets = new Map<string, PodcastAsset>();
    for (let index = 0; index < args.mediaIds.length; index++) {
      signal.throwIfAborted();
      const mediaId = args.mediaIds[index];
      const uri = await this.registry.originalUri(mediaId);
      if (!uri) throw new Error(`Recording ${mediaId} has no registered original. Relink it in Media before podcast setup.`);
      let parsed: URL;
      try { parsed = new URL(uri); } catch { throw new Error("Registered original reference is invalid."); }
      if (parsed.protocol !== "licketysplit-media:" || !UUID.test(parsed.hostname) || parsed.pathname !== "/original") throw new Error("Registered original reference is invalid.");
      const original = await this.registry.resolve(parsed.hostname, "original");
      onProgress({ phase: "inspect", completed: index, total: args.mediaIds.length, message: `Inspecting ${path.basename(original.path)}` });
      const { metadata, streams, containerStartSeconds, sourceMetadata } = await this.inspectMedia(original.path, signal);
      signal.throwIfAborted();
      if (!Number.isFinite(metadata.duration) || metadata.duration <= 0) throw new Error(`Could not verify the duration of ${path.basename(original.path)}.`);
      const prior = previousAssets.get(mediaId);
      const asset: PodcastAsset = {
        id: prior?.id ?? `asset-${stableId(mediaId)}`, mediaId, sourceId: parsed.hostname, name: path.basename(original.path),
        kind: metadata.hasVideo ? "video" : "audio", durationSeconds: metadata.duration,
        ...(containerStartSeconds !== undefined ? { containerStartSeconds } : {}),
        ...(metadata.frameRate > 0 ? { fps: metadata.frameRate } : {}),
        ...(metadata.width > 0 ? { width: metadata.width } : {}), ...(metadata.height > 0 ? { height: metadata.height } : {}),
        ...(metadata.sampleRate > 0 ? { sampleRate: metadata.sampleRate } : {}), ...(metadata.channels >= 0 ? { channels: metadata.channels } : {}),
        ...(metadata.fileSize >= 0 ? { sizeBytes: metadata.fileSize } : {}), ...(metadata.codec ? { codec: metadata.codec } : {}),
        streams,
        ...podcastSequenceMetadata(path.basename(original.path)),
        ...(sourceMetadata?.creationTime ? { creationTime: sourceMetadata.creationTime } : {}),
        ...(sourceMetadata?.timecode ? { timecode: sourceMetadata.timecode, timecodeOrigin: "embedded" as const } : {}),
        ...(sourceMetadata?.bwfTimeReferenceSamples ? { bwfTimeReferenceSamples: sourceMetadata.bwfTimeReferenceSamples } : {}),
        ...(sourceMetadata?.reel ? { reel: sourceMetadata.reel } : {}),
      };
      const nativeVideo = streams.find((stream) => stream.kind === "video");
      if (nativeVideo) {
        asset.nativeRate = nativeVideo.rate ?? nativeVideo.declaredRate;
        if (asset.timecode && asset.nativeRate) asset.sourceTimecodeRate = asset.nativeRate;
        asset.nativeVideoFrames = nativeVideo.frameCount;
        asset.nativeVideoDurationSeconds = nativeVideo.durationSeconds;
      }
      updatedAssets.set(mediaId, asset);
    }
    const assets = args.mediaIds.map((mediaId) => updatedAssets.get(mediaId)!);
    const weightedRates = new Map<number, number>();
    for (const asset of assets.filter((item) => item.kind === "video" && item.fps && item.fps > 0)) weightedRates.set(asset.fps!, (weightedRates.get(asset.fps!) ?? 0) + asset.durationSeconds);
    const timecodeFps = [...weightedRates.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 30;
    for (const asset of assets) {
      if (asset.timecode || !asset.bwfTimeReferenceSamples || !asset.sampleRate || asset.kind !== "audio") continue;
      const label = timecodeFromSampleReference(asset.bwfTimeReferenceSamples, asset.sampleRate, timecodeFps);
      if (!label) continue;
      asset.timecode = label;
      asset.timecodeOrigin = "bwf-derived-label";
      asset.sourceTimecodeRate = assets.find((candidate) => candidate.kind === "video" && candidate.nativeRate)?.nativeRate ?? { numerator: Math.round(timecodeFps * 1000), denominator: 1000 };
    }
    const groups = (() => {
      const automatic = groupPodcastAssets(assets);
      if (!previous) return automatic;
      const currentIds = new Set(assets.map((asset) => asset.id)), assigned = new Set<string>();
      const preserved = previous.groups.flatMap((group) => {
        const assetIds = group.assetIds.filter((assetId) => currentIds.has(assetId));
        if (!assetIds.length) return [];
        for (const assetId of assetIds) assigned.add(assetId);
        return [{ ...clone(group), assetIds }];
      });
      const added = automatic.flatMap((group) => {
        const assetIds = group.assetIds.filter((assetId) => !assigned.has(assetId));
        if (!assetIds.length) return [];
        for (const assetId of assetIds) assigned.add(assetId);
        return [{ ...group, assetIds }];
      });
      return [...preserved, ...added];
    })();
    const fallbackFps = assets.find((asset) => asset.kind === "video" && asset.fps && asset.fps > 0)?.fps ?? 30;
    const analysis: PodcastAnalysis = { version: 1, generatedAt: now(), projectName: previous?.analysis.projectName ?? "Podcast", fps: fallbackFps, assets, groups: clone(groups), warnings: groups.flatMap((group) => group.warnings) };
    const setup: PodcastSetup = previous ? revisePodcastSources(previous, analysis, groups, previous.participants) : {
      schemaVersion: 1, setupId: args.setupId ?? args.createSetupId ?? randomUUID(), projectId: args.projectId, revision: 0, createdAt: now(), updatedAt: now(), step: "setup",
      analysis, groups: clone(groups), participants: [], clockGroups: [], channels: [], edges: [], placements: [], state: "draft", warnings: [], transcriptCompatibility: "unbound",
    };
    assertPodcastSetup(setup);
    signal.throwIfAborted();
    await this.save(setup);
    return setup;
  }

  async revise(args: RevisePodcastArgs): Promise<PodcastSetup> {
    return this.withSetupMutation(args.setupId, async () => {
      const setup = await this.readSetup(args.setupId);
      const revised = revisePodcastSources(setup, setup.analysis, args.groups, args.participants);
      assertPodcastSetup(revised); await this.save(revised); return revised;
    });
  }

  async analyze(setupId: string, requestId: string, signal: AbortSignal, onProgress: (event: PodcastProgressUpdate) => void, retryAssetIds?: string[], prepareOnly = false, recovery?: PodcastAnalyzeRecovery): Promise<PodcastSetup> {
    validateSetupId(setupId);
    const requestUuid = UUID.test(requestId);
    if (!requestUuid) throw new Error("Invalid podcast analysis request ID.");
    if (this.activeSetups.has(setupId)) throw new Error("Podcast analysis is already active for this setup.");
    if (this.activeMutations.has(setupId)) throw new Error("A podcast setup change is already active.");
    this.activeSetups.add(setupId);
    try { await this.get(setupId); return await this.analyzeOwned(setupId, signal, onProgress, retryAssetIds, prepareOnly, recovery); }
    finally { this.activeSetups.delete(setupId); }
  }

  private async analyzeOwned(setupId: string, signal: AbortSignal, onProgress: (event: PodcastProgressUpdate) => void, retryAssetIds?: string[], prepareOnly = false, recovery?: PodcastAnalyzeRecovery): Promise<PodcastSetup> {
    const setup = await this.readSetup(setupId);
    if (setup.decodeFailure && !recovery) throw new Error("A podcast decode failure is unresolved. Choose an explicit recovery action before analyzing again.");
    let blockedAssetIds = setup.placements.filter((placement) => placement.status === "excluded" && placement.exception?.includes("decode failure")).map((placement) => placement.assetId);
    if (recovery) {
      const failure = setup.decodeFailure;
      if (!failure || recovery.failureId !== failure.id) throw new Error("This decode failure is stale. Refresh the setup before choosing a recovery action.");
      if (recovery.action === "save-and-stop") { setup.state = "error"; setup.progress = undefined; setup.updatedAt = now(); await this.save(setup); return setup; }
      if (recovery.action === "continue-unresolved") {
        if (failure.resolution === "unresolved-excluded") throw new Error("This source is already explicitly excluded after its decode failure. Resolve it manually or choose another copy.");
        const old = setup.placements.find((placement) => placement.assetId === failure.assetId);
        setup.placements = setup.placements.filter((placement) => placement.assetId !== failure.assetId);
        setup.placements.push({ assetId: failure.assetId, mapping: old?.mapping ?? { version: 1, scale: 1, offsetSeconds: 0 }, status: "excluded", component: old?.component ?? failure.assetId, locked: true, provenance: [...(old?.provenance ?? []), "user-decision:continue-unresolved"], exception: `Explicitly excluded after decode failure; resolve ${setup.analysis.assets.find((asset) => asset.id === failure.assetId)?.name ?? failure.assetId} manually before relying on it.` });
        failure.resolution = "unresolved-excluded";
        blockedAssetIds = [...new Set([...blockedAssetIds, failure.assetId])];
      } else {
        const asset = setup.analysis.assets.find((candidate) => candidate.id === failure.assetId)!;
        const mediaId = recovery.alternateMediaId;
        if (!mediaId || !mediaId.trim()) throw new Error("Choose a registered alternate copy to continue.");
        const registered = await this.registry.findMedia(mediaId);
        if (!registered || registered.identity.assetId === failure.sourceId || registered.identity.mediaId !== mediaId) throw new Error("Choose a different registered original as the alternate copy.");
        const original = await this.registry.resolve(registered.identity.assetId, "original");
        const inspected = await this.inspectMedia(original.path, signal);
        const packetFacts = await this.inspectPackets(original.path, signal);
        signal.throwIfAborted();
        const verified = await this.registry.findMedia(mediaId);
        if (!verified || verified.identity.assetId !== registered.identity.assetId || verified.identity.sha256 !== registered.identity.sha256) throw new Error("The alternate original changed during verification. Refresh Media and try again.");
        await this.registry.resolve(verified.identity.assetId, "original");
        const stream = packetFacts.streams.find((candidate) => candidate.index === failure.streamIndex && candidate.kind === "audio");
        if (!stream || !Number.isInteger(stream.channels) || stream.channels! <= failure.channelIndex) throw new Error("The alternate copy does not contain the failed audio stream and channel. Assign a compatible recording copy.");
        if (!Number.isFinite(inspected.metadata.duration) || inspected.metadata.duration <= 0) throw new Error("The alternate copy has no verified duration.");
        if ((inspected.metadata.hasVideo ? "video" : "audio") !== asset.kind) throw new Error("The alternate copy has a different recording kind and cannot preserve this assignment.");
        for (const group of setup.groups.filter((candidate) => candidate.assetIds.includes(asset.id))) {
          if (group.role === "camera" && !packetFacts.streams.some((candidate) => candidate.kind === "video")) throw new Error("The alternate copy lacks the video stream required by its camera assignment.");
          for (const binding of group.audioBindings ?? []) {
            if (binding.assetId !== asset.id) continue;
            const bound = packetFacts.streams.find((candidate) => candidate.index === binding.streamIndex && candidate.kind === "audio");
            if (!bound || (binding.channel !== undefined && (!Number.isInteger(bound.channels) || bound.channels! <= binding.channel))) throw new Error("The alternate copy cannot preserve every assigned audio stream and channel.");
          }
        }
        const refreshed: PodcastAsset = {
          // Assignment IDs remain stable, but source facts must describe the replacement file.
          ...asset, mediaId, sourceId: registered.identity.assetId, sourceDigest: registered.identity.sha256,
          name: path.basename(original.path), kind: inspected.metadata.hasVideo ? "video" : "audio", durationSeconds: inspected.metadata.duration,
          containerStartSeconds: packetFacts.containerStartSeconds ?? inspected.containerStartSeconds,
          sampleRate: inspected.metadata.sampleRate, channels: inspected.metadata.channels, sizeBytes: registered.identity.byteLength,
          codec: inspected.metadata.codec, streams: packetFacts.streams,
          fps: inspected.metadata.frameRate > 0 ? inspected.metadata.frameRate : undefined,
          frames: undefined,
          width: inspected.metadata.width > 0 ? inspected.metadata.width : undefined,
          height: inspected.metadata.height > 0 ? inspected.metadata.height : undefined,
          nativeRate: packetFacts.streams.find((candidate) => candidate.kind === "video")?.rate ?? packetFacts.streams.find((candidate) => candidate.kind === "video")?.declaredRate,
          nativeVideoFrames: packetFacts.streams.find((candidate) => candidate.kind === "video")?.frameCount,
          nativeVideoDurationSeconds: packetFacts.streams.find((candidate) => candidate.kind === "video")?.durationSeconds,
          timecode: inspected.sourceMetadata?.timecode,
          sourceTimecodeRate: inspected.sourceMetadata?.timecode
            ? (packetFacts.streams.find((candidate) => candidate.kind === "video")?.rate ?? packetFacts.streams.find((candidate) => candidate.kind === "video")?.declaredRate)
            : undefined,
          timecodeOrigin: inspected.sourceMetadata?.timecode ? "embedded" : undefined,
          creationTime: inspected.sourceMetadata?.creationTime,
          bwfTimeReferenceSamples: inspected.sourceMetadata?.bwfTimeReferenceSamples,
          reel: inspected.sourceMetadata?.reel,
          ...podcastSequenceMetadata(path.basename(original.path)),
        };
        const revised = revisePodcastSources(setup, { ...setup.analysis, generatedAt: now(), assets: setup.analysis.assets.map((candidate) => candidate.id === asset.id ? refreshed : candidate) }, setup.groups, setup.participants);
        revised.decodeFailure = undefined;
        Object.assign(setup, revised);
        retryAssetIds = [asset.id];
        blockedAssetIds = blockedAssetIds.filter((id) => id !== asset.id);
      }
    }
    if (setup.analysisProposal) throw new Error("Apply or discard the pending timing proposal before another analysis.");
    if (!setup.groups.some((group) => group.assetIds.length)) throw new Error("Choose at least one source in Setup before analysis.");
    const previous = clone(setup);
    const hasTiming = setup.placements.length > 0;
    setup.state = "analyzing"; setup.progress = { completed: 0, total: setup.groups.flatMap((group) => group.assetIds).length, message: "Starting native analysis" }; setup.updatedAt = now(); await this.save(setup);
    const started = performance.now();
    try {
      const included = [...new Set(setup.groups.flatMap((group) => group.assetIds))];
      const inspectIds: string[] | undefined = recovery ? [] : undefined;
      for (let index = 0; index < included.length; index++) {
        signal.throwIfAborted();
        const asset = setup.analysis.assets.find((candidate) => candidate.id === included[index])!;
        const registered = await this.registry.findMedia(asset.mediaId);
        if (!registered || registered.identity.assetId !== asset.sourceId) throw new Error(`${asset.name} was relinked. Revise Setup to confirm the current original before analysis.`);
        asset.sourceDigest = registered.identity.sha256;
        const original = await this.registry.resolve(asset.sourceId, "original");
        if (inspectIds && !inspectIds.includes(asset.id)) continue;
        onProgress({ phase: "inspect", completed: index, total: included.length, message: `Verifying presented timestamps for ${asset.name}` });
        const packetFacts = await this.inspectPackets(original.path, signal);
        asset.streams = packetFacts.streams;
        if (packetFacts.containerStartSeconds !== undefined) asset.containerStartSeconds = packetFacts.containerStartSeconds;
        const video = packetFacts.streams.find((stream) => stream.kind === "video");
        if (video) {
          asset.nativeRate = video.rate ?? video.declaredRate ?? asset.nativeRate;
          asset.nativeVideoFrames = video.frameCount ?? asset.nativeVideoFrames;
          asset.nativeVideoDurationSeconds = video.durationSeconds ?? asset.nativeVideoDurationSeconds;
          if (asset.timecodeOrigin === "embedded" && asset.nativeRate) asset.sourceTimecodeRate = asset.nativeRate;
        }
        setup.warnings.push(...packetFacts.warnings.map((warning) => `${asset.name}: ${warning}`));
        await waitTurn();
      }
      await this.save(setup);
      const activeIds = included.filter((id) => !blockedAssetIds.includes(id));
      if (!activeIds.length) {
        setup.state = "review"; setup.progress = undefined; setup.updatedAt = now(); await this.save(setup); return setup;
      }
      const result = await analyzePodcastSetup({ setup, registry: this.registry, audio: this.audio, cacheDir: this.analysisDir, signal, retryAssetIds, blockedAssetIds: [...new Set(blockedAssetIds)], prepareOnly, onProgress });
      result.metrics.wallSeconds = (performance.now() - started) / 1000;
      result.setup.metrics = result.metrics;
      result.setup.updatedAt = now(); result.setup.progress = undefined;
      if (hasTiming && recovery?.action !== "continue-unresolved") {
        stagePodcastProposal(result.setup, previous, setup.groups.flatMap((group) => group.assetIds));
      } else {
        result.setup.revision = setup.revision;
      }
      await this.save(result.setup); return result.setup;
    } catch (error) {
      const latest = await this.get(setupId).catch(() => setup);
      latest.state = signal.aborted ? "canceled" : "error"; latest.progress = undefined; latest.updatedAt = now();
      if (error instanceof PodcastAudioReadError) latest.decodeFailure = error.decodeFailure;
      latest.warnings.push(signal.aborted ? "Analysis canceled safely. Completed bounded-window feature caches remain reusable." : `Analysis failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.save(latest);
      throw error;
    }
  }

  async update(request: PodcastUpdateRequest): Promise<PodcastSetup> {
    return this.withSetupMutation(request.setupId, async () => {
      const setup = await this.readSetup(request.setupId), project = asSyncProject(setup);
      applyPodcastUpdate(project, request);
      setup.referenceAssetId = project.referenceAssetId || undefined;
      setup.clockGroups = clone(project.clockGroups);
      setup.channels = project.channels.map(({ receipt: _receipt, audioOrdinal: _ordinal, featureFile: _file, featureCacheKey: _key, ...channel }) => channel);
      setup.edges = clone(project.edges); setup.placements = clone(project.placements);
      setup.reviewChecks = clone(project.reviewChecks); setup.regionEvidence = clone(project.regionEvidence);
      setup.validationReservations = clone(project.validationReservations);
      setup.analysisProposal = clone(project.analysisProposal) as PodcastSetup["analysisProposal"];
      setup.timingUndo = clone(project.timingUndo) as PodcastSetup["timingUndo"];
      setup.analysisAlgorithm = project.algorithm;
      setup.analysisParametersDigest = typeof project.parameters === "string" ? project.parameters : undefined;
      setup.state = project.state; setup.revision = project.revision; setup.updatedAt = project.updatedAt;
      setup.approval = clone(project.approval); setup.transcriptCompatibility = project.transcriptCompatibility;
      setup.warnings = clone(project.warnings); setup.metrics = project.metrics;
      assertPodcastSetup(setup); await this.save(setup); return setup;
    });
  }

  async approve(setupId: string, expectedRevision: number): Promise<PodcastSetup> {
    return this.withSetupMutation(setupId, async () => {
      const setup = await this.readSetup(setupId);
      if (setup.revision !== expectedRevision) throw new Error("Podcast setup changed. Review the current timing before approving it.");
      if (setup.decodeFailure && setup.decodeFailure.resolution !== "unresolved-excluded") throw new Error("Resolve or explicitly exclude the unresolved podcast decode failure before approving timing.");
      await this.assertCurrentIncludedSources(setup);
      const project = asSyncProject(setup);
      const included = new Set(setup.groups.flatMap((group) => group.assetIds));
      const placements = project.placements.filter((placement) => included.has(placement.assetId));
      if (placements.length !== included.size) throw new Error("Resolve each included source before approving timing.");
      assertNativeApprovalEligible(project);
      setup.placements = clone(project.placements);
      setup.approval = { revision: setup.revision, mappingDigest: nativeSetupMappingDigest(setup), approvedAt: now() };
      setup.state = "approved"; setup.updatedAt = now();
      assertNativeSyncApproval(asSyncProject(setup));
      await this.save(setup); return setup;
    });
  }
}
