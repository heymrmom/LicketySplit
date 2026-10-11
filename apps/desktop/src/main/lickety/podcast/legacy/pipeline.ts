import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { PodcastAsset, PodcastSetup, PodcastSetupMetrics, PodcastSyncChannel } from "../../../../../../../packages/core/src/lickety/podcast-types";
import type { PodcastWorkLedger } from "../progress-ledger";
import { DSP_VERSION } from "../dsp";
import { SYNC_PARAMETERS } from "../parameters";
import { boundedPcm, extractFeatures, loadFeatures, type ChannelWork, type PodcastAssetRegistry, type PodcastProgressUpdate } from "../engine";
import { cachedPodcastWork, podcastCacheDigest } from "../work-cache";
import type { NativeAudioAnalysis } from "../../audio-analysis";
import { matchChannels, solveGraph } from "./matcher";
import { validateClockNetwork } from "./validation";
import { proposeRegionalMappings } from "./region-fit";
import { validationReservations } from "./evidence-history";
import { audioSpans, audioTimestampBlockers } from "./regions";
import type { SyncChannel, SyncProject } from "./types";

const ANALYSIS_RATE = 8000;
const DECODER_VERSION = "native-bounded-window-pan-preroll-input-cap-timestamp-fill-v3";
const waitTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function makeReceipt(channel: PodcastSyncChannel, asset: PodcastAsset, audioOrdinal: number) {
  const stream = asset.streams?.find((item) => item.index === channel.streamIndex);
  const firstPTSSeconds = channel.firstPTSSeconds ?? stream?.startSeconds ?? asset.containerStartSeconds ?? 0;
  const frames = channel.frames, sampleRate = channel.sampleRate;
  return {
    version: 1 as const, decoder: DECODER_VERSION, audioTrackOrdinal: audioOrdinal,
    channels: stream?.channels ?? Math.max(1, channel.channel + 1), sampleRate,
    nativeSampleRate: stream?.sampleRate ?? ANALYSIS_RATE, firstPTSSeconds,
    trackStartSeconds: firstPTSSeconds, trackDurationSeconds: frames / sampleRate,
    frames, decodedDurationSeconds: frames / sampleRate,
    discontinuities: channel.discontinuities ?? stream?.discontinuities ?? [],
  };
}

function fromPortableChannel(channel: PodcastSyncChannel, asset: PodcastAsset): SyncChannel {
  const audioStreams = (asset.streams ?? []).filter((stream) => stream.kind === "audio").sort((a, b) => a.index - b.index);
  const audioOrdinal = Math.max(0, audioStreams.findIndex((stream) => stream.index === channel.streamIndex));
  return { ...channel, audioOrdinal, featureFile: "", featureCacheKey: channel.cacheKey, receipt: makeReceipt(channel, asset, audioOrdinal) };
}

export async function analyzeLegacyPodcastSetup(args: {
  setup: PodcastSetup;
  registry: PodcastAssetRegistry;
  audio: NativeAudioAnalysis;
  cacheDir: string;
  signal: AbortSignal;
  retryAssetIds?: string[];
  blockedAssetIds?: string[];
  prepareOnly?: boolean;
  onProgress: (event: PodcastProgressUpdate) => void;
  work?: PodcastWorkLedger;
}): Promise<{ setup: PodcastSetup; metrics: PodcastSetupMetrics }> {
  const { setup, registry, audio, cacheDir, signal, retryAssetIds, blockedAssetIds = [], prepareOnly = false, onProgress } = args;
  const report = (event: PodcastProgressUpdate, id?: string, state: import("../../../../../../../packages/core/src/lickety/podcast-types").PodcastWorkItem["status"] = "running", fraction = 0) => args.work ? args.work.report(event, id, state, fraction) : onProgress(event);
  const allIncluded = [...new Set(setup.groups.flatMap((group) => group.assetIds))];
  const blocked = new Set(blockedAssetIds);
  const included = allIncluded.filter((id) => !blocked.has(id));
  const assetById = new Map(setup.analysis.assets.map((asset) => [asset.id, asset]));
  if (!allIncluded.length || allIncluded.some((id) => !assetById.has(id)) || !included.length) throw new Error("Choose inventoried sources before analysis.");
  if (blockedAssetIds.some((id) => !allIncluded.includes(id))) throw new Error("An unresolved source is no longer part of this setup.");
  if (prepareOnly && setup.placements.length) throw new Error("Sources are already prepared. Retry audio matching or review the saved placements.");

  const channelWork: ChannelWork[] = [];
  const totalChannels = included.reduce((sum, id) => sum + (assetById.get(id)!.streams ?? []).filter((stream) => stream.kind === "audio").reduce((count, stream) => count + Math.min(stream.channels ?? assetById.get(id)!.channels ?? 0, 64), 0), 0);
  let cacheHits = 0, cacheMisses = 0, decodeSeconds = 0, peakRssBytes = process.memoryUsage().rss;
  await mkdir(cacheDir, { recursive: true });
  for (let i = 0; i < included.length; i++) {
    signal.throwIfAborted();
    const asset = assetById.get(included[i])!;
    report({ phase: "inspect", completed: i, total: included.length, message: `Preparing ${asset.name}` });
    const assetChannelCount = (asset.streams ?? []).filter(stream => stream.kind === "audio").reduce((n,stream)=>n+Math.min(stream.channels ?? asset.channels ?? 0,64),0);
    let assetChannelsDone = 0, assetAllCached = true;
    const registered = await registry.findMedia(asset.mediaId);
    if (!registered) throw new Error(`${asset.name} is unavailable. Relink the original recording before podcast setup.`);
    if (registered.identity.assetId !== asset.sourceId) throw new Error(`${asset.name} was relinked to a different registered source. Revise setup to confirm the replacement.`);
    const audioStreams = (asset.streams ?? []).filter((stream) => stream.kind === "audio").sort((a, b) => a.index - b.index);
    for (let ordinal = 0; ordinal < audioStreams.length; ordinal++) {
      const stream = audioStreams[ordinal], channelCount = Math.min(stream.channels ?? asset.channels ?? 0, 64);
      for (let channel = 0; channel < channelCount; channel++) {
        signal.throwIfAborted();
        report({ phase: "decode", completed: channelWork.length, total: totalChannels, message: `Reading ${asset.name}, audio stream ${stream.index}, channel ${channel + 1}` }, `features:${asset.id}`, "running", assetChannelsDone / Math.max(1,assetChannelCount));
        const extracted = await extractFeatures({ asset, stream, sourceId: registered.identity.assetId, sha256: registered.identity.sha256, audioOrdinal: ordinal, streamIndex: stream.index, channelIndex: channel, audio, directory: cacheDir, signal, onProgress: event => report(event, `features:${asset.id}`, "running", (assetChannelsDone + (event.total > 0 ? Math.min(1,event.completed/event.total) : 0)) / Math.max(1,assetChannelCount)) });
        channelWork.push(extracted.work); decodeSeconds += extracted.decodeSeconds;
        if (extracted.cacheHit) cacheHits++; else cacheMisses++;
        assetAllCached &&= extracted.cacheHit; assetChannelsDone++;
      }
    }
    report({ phase: "features", completed: assetChannelsDone, total: assetChannelCount, message: `Prepared sound for ${asset.name}` }, `features:${asset.id}`, !assetChannelCount ? "skipped" : assetAllCached ? "reused" : "done");
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    await waitTurn();
  }

  const channels: SyncChannel[] = channelWork.map((work) => ({ ...work.channel, audioOrdinal: work.audioOrdinal, featureFile: work.featureFile, featureCacheKey: work.featureCacheKey, receipt: work.receipt }));
  const priorChannels = setup.channels.filter((channel) => !blocked.has(channel.assetId)).map((channel) => fromPortableChannel(channel, assetById.get(channel.assetId)!));
  const fps = setup.timelineRate ? setup.timelineRate.numerator / setup.timelineRate.denominator : setup.analysis.fps;
  const reference = setup.referenceAssetId && included.includes(setup.referenceAssetId) ? setup.referenceAssetId
    : included.map((id) => assetById.get(id)!).sort((a, b) => Number(b.kind === "audio") - Number(a.kind === "audio") || b.durationSeconds - a.durationSeconds)[0].id;
  const workProject: SyncProject = {
    schemaVersion: 1,
    algorithm: setup.analysisAlgorithm ?? "",
    ...(setup.analysisParametersDigest === podcastCacheDigest(SYNC_PARAMETERS) ? { parameters: SYNC_PARAMETERS } : {}),
    id: setup.setupId, revision: setup.revision, createdAt: setup.createdAt, updatedAt: setup.updatedAt,
    name: setup.analysis.projectName, analysis: setup.analysis, groups: setup.groups,
    timelineRate: setup.timelineRate ?? { numerator: Math.round(fps * 1000), denominator: 1000 },
    referenceAssetId: reference, clockGroups: structuredClone(setup.clockGroups), channels: priorChannels,
    edges: structuredClone(setup.edges), placements: structuredClone(setup.placements),
    reviewChecks: structuredClone(setup.reviewChecks ?? []), regionEvidence: structuredClone(setup.regionEvidence ?? []),
    validationReservations: structuredClone(setup.validationReservations ?? []), state: setup.state,
    approval: structuredClone(setup.approval), transcriptCompatibility: setup.transcriptCompatibility ?? "unbound",
    warnings: [...setup.warnings], metrics: { wallSeconds: 0, peakRssBytes: 0, decodeSeconds: 0, cacheHits: 0, cacheMisses: 0 },
    sourceHistory: (setup.sourceHistory ?? []).flatMap((entry) => {
      const asset = entry.asset ?? assetById.get(entry.assetId);
      return asset ? [{ ...entry, asset }] : [];
    }),
  };
  const readFeatures = async (channel: SyncChannel) => {
    const work = channelWork.find((item) => item.channel.id === channel.id);
    if (!work) throw new Error(`Feature cache for ${channel.id} is unavailable.`);
    return loadFeatures(work.featureFile, work.channel.cacheKey, work.featureCacheKey);
  };
  const readPcm = async (channel: SyncChannel, sourceStartSeconds: number, durationSeconds: number) => {
    signal.throwIfAborted();
    const span = audioSpans(channel.receipt).find((candidate) => sourceStartSeconds >= candidate.lo - 0.5 / channel.receipt.sampleRate && sourceStartSeconds + durationSeconds <= candidate.hi + 1 / channel.receipt.sampleRate);
    if (!span) return new Float32Array();
    const asset = assetById.get(channel.assetId)!;
    const startMs = (sourceStartSeconds - (asset.containerStartSeconds ?? 0)) * 1000;
    if (startMs < -500 / ANALYSIS_RATE) return new Float32Array();
    return boundedPcm(audio, channel.sourceId, channel.audioOrdinal, channel.channel, Math.max(0, startMs), Math.round(durationSeconds * ANALYSIS_RATE), signal);
  };

  const edges: SyncProject["edges"] = [];
  const matchDir = path.join(cacheDir, "..", "matches");
  await mkdir(matchDir, { recursive: true });
  let pairsDone = 0;
  const totalPairs = included.length * (included.length - 1) / 2;
  for (let i = 0; i < included.length; i++) for (let j = i + 1; j < included.length; j++) {
    signal.throwIfAborted();
    const a = included[i], b = included[j];
    const pairId = `match:${a}:${b}`;
    const pairEvent = { phase: "match" as const, completed: pairsDone++, total: totalPairs, message: `Checking common audio: ${assetById.get(a)!.name} / ${assetById.get(b)!.name}` };
    if (workProject.clockGroups.some((group) => group.confirmed && group.sourceStarts && group.assetIds.includes(a) && group.assetIds.includes(b))) { report(pairEvent,pairId,"skipped"); continue; }
    const old = workProject.edges.filter((edge) => edge.a === a && edge.b === b);
    const unchanged = old.every((edge) => [edge.channelA, edge.channelB].every((id) => channels.find((channel) => channel.id === id)?.cacheKey === workProject.channels.find((channel) => channel.id === id)?.cacheKey));
    if (workProject.algorithm === DSP_VERSION && podcastCacheDigest(workProject.parameters) === podcastCacheDigest(SYNC_PARAMETERS) && retryAssetIds && !retryAssetIds.includes(a) && !retryAssetIds.includes(b) && old.length && unchanged) {
      edges.push(...old); report(pairEvent,pairId,"reused"); continue;
    }
    report(pairEvent,pairId);
    let pairAllCached = true;
    const leftChannels = channels.filter((channel) => channel.assetId === a && channel.usable).sort((x, y) => y.rms - x.rms);
    const rightChannels = channels.filter((channel) => channel.assetId === b && channel.usable).sort((x, y) => y.rms - x.rms);
    const pairEdges: SyncProject["edges"] = [];
    for (const left of leftChannels) for (const right of rightChannels) {
      signal.throwIfAborted();
      const identity = { algorithm: DSP_VERSION, parameters: SYNC_PARAMETERS,
        a: [left.id, left.cacheKey, left.receipt, left.usable], b: [right.id, right.cacheKey, right.receipt, right.usable] };
      const cached = await cachedPodcastWork(matchDir, "channel-match", identity,
        () => matchChannels(left, right, readFeatures, readPcm, signal), signal,
        (value): value is SyncProject["edges"][number] => !!value && typeof value === "object" && Array.isArray((value as SyncProject["edges"][number]).anchors) && Array.isArray((value as SyncProject["edges"][number]).candidates) && ["measured", "needs-review", "ambiguous", "unmatched"].includes((value as SyncProject["edges"][number]).status));
      pairEdges.push(cached.value); pairAllCached &&= cached.cacheHit;
      await waitTurn();
    }
    const quality = (edge: SyncProject["edges"][number]) => edge.anchors.reduce((sum, anchor) => sum + anchor.score * anchor.score, 0) / Math.max(1, edge.anchors.length);
    const measured = pairEdges.filter((edge) => edge.status === "measured").sort((x, y) => quality(y) - quality(x));
    if (measured.length) {
      const best = measured[0];
      for (const alternate of measured.slice(1)) {
        const discrepancy = Math.max(...best.anchors.map((anchor) => Math.abs((best.mapping!.scale * anchor.sourceSeconds + best.mapping!.offsetSeconds) - (alternate.mapping!.scale * anchor.sourceSeconds + alternate.mapping!.offsetSeconds)) * 1000));
        if (quality(alternate) >= quality(best) * 0.85 && discrepancy > 5) { best.status = "ambiguous"; best.reason = "Strong channel pairs disagree about the source clock."; }
        alternate.status = "needs-review"; alternate.reason = "Alternative channel evidence retained; stronger pair selected for the graph.";
      }
    }
    report({...pairEvent,completed:pairsDone},pairId,!pairEdges.length ? "skipped" : pairAllCached ? "reused" : "done");
    edges.push(...pairEdges);
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }

  const excludedPlacements = structuredClone(setup.placements.filter((placement) => blocked.has(placement.assetId)));
  const previous = structuredClone(workProject.placements.filter((placement) => !blocked.has(placement.assetId)));
  const retained = new Set(retryAssetIds ? previous.filter((placement) => !retryAssetIds.includes(placement.assetId)).map((placement) => placement.assetId) : []);
  for (const placement of previous) if (retained.has(placement.assetId) && placement.status !== "manual" && placement.status !== "excluded") placement.locked = true;
  const placements = [...solveGraph(included, reference, prepareOnly ? [] : edges, previous, workProject.clockGroups), ...excludedPlacements];
  const warnings = [...setup.warnings];
  for (const placement of placements) {
    const asset = assetById.get(placement.assetId)!;
    for (const stream of asset.streams ?? []) {
      if ((stream.kind !== "audio" && stream.kind !== "video") || stream.auxiliaryVideo) continue;
      if (stream.timestampStatus !== "continuous" || stream.startSeconds === undefined) {
        const reason = `${stream.kind === "audio" ? "Audio" : "Video"} stream ${stream.index} presentation origin is ${stream.timestampStatus ?? "unknown"}; relative waveform timing remains provisional.`;
        placement.unsupported = [...new Set([...(placement.unsupported ?? []), reason])];
        warnings.push(`${asset.name}: ${reason}`);
      }
    }
    placement.unsupported = [...new Set([...(placement.unsupported ?? []), ...channels.filter((channel) => channel.assetId === placement.assetId).flatMap((channel) => audioTimestampBlockers(channel.receipt))])];
  }

  const legacyProgress = (event: PodcastProgressUpdate) => report(event,event.assetId ? `validate:${event.assetId}` : undefined);
  const regionProgress = (event: PodcastProgressUpdate) => report(event,event.assetId ? `regions:${event.assetId}` : undefined,"running",event.total>0?event.completed/event.total:0);
  let reviewChecks: SyncProject["reviewChecks"] = [];
  let regionEvidence: SyncProject["regionEvidence"] = structuredClone(workProject.regionEvidence ?? []);
  if (prepareOnly) {
    for (const placement of placements) placement.provenance.push(placement.status === "reference" ? "Original streams inventoried; no cross-file audio match asserted." : "Awaiting explicit placement; audio matching was not requested.");
  } else {
    const reviewProject: SyncProject = { ...workProject, referenceAssetId: reference, channels, edges, placements, validationReservations: validationReservations(workProject) };
    reviewChecks = await validateClockNetwork(reviewProject, legacyProgress, readPcm, signal, (workProject.reviewChecks ?? []).filter((check) => check.status === "failed").map((check) => check.projectSeconds));
    for (const check of reviewChecks.filter((item) => item.status === "failed")) {
      const placement = placements.find((item) => item.assetId === check.assetId)!;
      if (!placement.locked && placement.status !== "manual") placement.status = "unresolved";
      placement.provenance.push(`boundary-validation:${check.residualMs.toFixed(3)}ms at project ${check.projectSeconds.toFixed(3)}s`);
    }
    const regionalIds = [...new Set([...reviewChecks.filter((check) => check.status === "failed").map((check) => check.assetId), ...placements.filter((placement) => placement.regions?.some((region) => region.status === "unresolved")).map((placement) => placement.assetId)])].filter((id) => !retained.has(id));
    const newEvidence = await proposeRegionalMappings({ ...reviewProject, reviewChecks: [...(workProject.reviewChecks ?? []), ...reviewChecks] }, regionalIds, regionProgress, readPcm, signal);
    regionEvidence = [...(workProject.regionEvidence ?? []).filter((evidence) => !newEvidence.some((next) => next.assetId === evidence.assetId)), ...newEvidence];
    if (newEvidence.length) reviewChecks = await validateClockNetwork({ ...reviewProject, regionEvidence }, legacyProgress, readPcm, signal, reviewChecks.filter((check) => check.status === "failed").map((check) => check.projectSeconds));
    for (const check of reviewChecks.filter((item) => item.status === "failed")) {
      const placement = placements.find((item) => item.assetId === check.assetId)!;
      const region = placement.regions?.find((item) => check.sourceSeconds >= item.sourceStartSeconds && check.sourceSeconds < item.sourceEndSeconds);
      if (region && !region.locked && region.status !== "manual" && region.status !== "excluded") {
        region.status = "unresolved"; region.provenance.push(`Independent check failed: ${check.residualMs} ms at source ${check.sourceSeconds}`);
      } else if (!placement.locked && placement.status !== "manual") placement.status = "unresolved";
    }
    for (const placement of placements) {
      if (retained.has(placement.assetId)) Object.assign(placement, structuredClone(workProject.placements.find((old) => old.assetId === placement.assetId)!));
      else if (placement.status === "unresolved") {
        const failed = reviewChecks.filter((check) => check.assetId === placement.assetId && check.status === "failed");
        placement.reviewReason = failed.length ? (Math.max(...failed.map((check) => Math.abs(check.residualMs))) <= 10 ? "small-discrepancy" : "conflicting-timing") : "insufficient-evidence";
      }
    }
  }

  args.work?.finishStage("validate",prepareOnly ? "skipped" : "done");
  args.work?.finishStage("regions",prepareOnly ? "skipped" : "done");
  for (const id of blockedAssetIds) for (const stage of ["features","validate","regions"] as const) report({phase:"solve",completed:0,total:0,message:"Recording left unresolved by recovery choice"},`${stage}:${id}`,"skipped");
  if (args.work) for (const item of args.work.snapshot().items.filter(item=>item.stage==="match"&&item.assetIds.some(id=>blocked.has(id)))) report({phase:"match",completed:0,total:0,message:"Comparison skipped for excluded recovery source"},item.id,"skipped");
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  const metrics: PodcastSetupMetrics = { wallSeconds: 0, peakRssBytes, decodeSeconds, cacheHits, cacheMisses };
  const portableChannels: PodcastSyncChannel[] = channels.map(({ receipt: _receipt, audioOrdinal: _ordinal, featureFile: _file, featureCacheKey: _featureKey, ...channel }) => channel);
  const result: PodcastSetup = {
    ...setup, analysisAlgorithm: DSP_VERSION, analysisParametersDigest: podcastCacheDigest(SYNC_PARAMETERS),
    referenceAssetId: reference, channels: portableChannels, edges, placements, reviewChecks, regionEvidence,
    validationReservations: validationReservations({ ...workProject, channels, edges, placements, reviewChecks, regionEvidence }),
    state: "review", approval: undefined, transcriptCompatibility: setup.transcriptCompatibility === "unbound" ? "unbound" : "stale",
    warnings: [...new Set(warnings)], metrics,
  };
  report({ phase: "done", completed: included.length, total: included.length, message: "Analysis ready for saving; unsupported timestamps and unresolved clock regions remain explicit." });
  return { setup: result, metrics };
}
