import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import type { PodcastGroup, PodcastParticipant, PodcastSetup } from "../../../../../../../packages/core/src/lickety/podcast-types";
import { analyzeMulticamDrift } from "../../../../../../../packages/core/src/multicam/drift";
import { ManagedAssetRegistry } from "../../asset-registry";
import { HeavyJobQueue } from "../../media-jobs";
import { createAudioDecodeCapture, NativeAudioAnalysis, type AudioDecodeCapture } from "../../audio-analysis";
import { PodcastNativeService } from "../service";
import { analyzeLegacyPodcastSetup } from "../legacy/pipeline";

const enabled = Boolean(process.env.TAKEOVER_HOUR_FIXTURE);
const fixtureTest = enabled ? it : it.skip;
const fixturePath = () => path.resolve(process.env.TAKEOVER_HOUR_FIXTURE!);
const outputPath = () => path.join(fixturePath(), "benchmark");
const profilePath = () => path.join(fixturePath(), "profile-cold");
const ffmpegPath = path.resolve(process.env.TAKEOVER_HOUR_FFMPEG ?? "resources/bin/darwin-arm64/ffmpeg");

interface SourceFact {
  id: string; mediaId: string; path: string; file: string; sha256: string; kind: "camera" | "microphone";
  sampleRate: number; channels: number; durationSeconds: number; physicalIdentity: string;
  mapping: { version: 1; scale: number; offsetSeconds: number };
}
interface FixtureManifest { durationSeconds: number; sources: SourceFact[]; expected: { measurementPoints: number[] } }
interface ChallengeManifest { challengeSources: Array<{ id: string; mediaId: string; path: string; durationSeconds: number; mode: string }> }

const readManifest = async (): Promise<FixtureManifest> => JSON.parse(await readFile(path.join(fixturePath(), "manifest.json"), "utf8")) as FixtureManifest;

const metrics = {
  requestedWindows: 0, maxRequestedWindowMs: 0, maxNativePayloadBytes: 0,
  maxInputDecodeSeconds: 0, activeChildren: 0, maxActiveChildren: 0,
  peakChildRssBytes: 0, peakProcessRssBytes: process.memoryUsage().rss,
};
const childPids = new Set<number>();
let rssTimer: ReturnType<typeof setInterval> | undefined;
let samplingChildRss = false;

async function sampleChildRss() {
  if (samplingChildRss) return;
  samplingChildRss = true;
  try {
  metrics.peakProcessRssBytes = Math.max(metrics.peakProcessRssBytes, process.memoryUsage().rss);
  if (!childPids.size) return;
  const pids = [...childPids].join(",");
  const child = spawn("/bin/ps", ["-o", "rss=", "-p", pids], { stdio: ["ignore", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  for (const value of Buffer.concat(chunks).toString("utf8").trim().split(/\s+/)) {
    const kib = Number(value);
    if (Number.isFinite(kib)) metrics.peakChildRssBytes = Math.max(metrics.peakChildRssBytes, kib * 1024);
  }
  } finally { samplingChildRss = false; }
}

function captureWithPinnedFfmpeg(args: string[], signal: AbortSignal): Promise<AudioDecodeCapture> {
  signal.throwIfAborted();
  const inputCap = args.indexOf("-t");
  if (inputCap >= 0 && args.indexOf("-i") > inputCap) metrics.maxInputDecodeSeconds = Math.max(metrics.maxInputDecodeSeconds, Number(args[inputCap + 1]));
  return new Promise<AudioDecodeCapture>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    if (child.pid) childPids.add(child.pid);
    metrics.activeChildren++;
    metrics.maxActiveChildren = Math.max(metrics.maxActiveChildren, metrics.activeChildren);
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let bytes = 0;
    let stderrBytes = 0;
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 ** 2) { child.kill("SIGKILL"); reject(new Error("Bounded audio output exceeded 16 MiB.")); }
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 1024 * 1024) stderrChunks.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (child.pid) childPids.delete(child.pid);
      metrics.activeChildren--;
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else if (code !== 0) reject(new Error(`Pinned FFmpeg exited ${code}.`));
      else {
        metrics.maxNativePayloadBytes = Math.max(metrics.maxNativePayloadBytes, bytes);
        const buffer = Buffer.concat(chunks);
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        resolve(createAudioDecodeCapture(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer, stderr, true, stderrBytes > 1024 * 1024));
      }
    });
  });
}

function createAudio(registry: ManagedAssetRegistry, queue: HeavyJobQueue) {
  const native = new NativeAudioAnalysis(registry, queue, captureWithPinnedFfmpeg);
  const original = native.getNativeAudioWindow.bind(native);
  native.getNativeAudioWindow = async (...args: Parameters<typeof native.getNativeAudioWindow>) => {
    metrics.requestedWindows++;
    metrics.maxRequestedWindowMs = Math.max(metrics.maxRequestedWindowMs, args[3]);
    return original(...args);
  };
  return native;
}

async function directoryBytes(root: string): Promise<{ files: number; bytes: number; largestJsonBytes: number }> {
  let files = 0, bytes = 0, largestJsonBytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const sub = await directoryBytes(file); files += sub.files; bytes += sub.bytes; largestJsonBytes = Math.max(largestJsonBytes, sub.largestJsonBytes);
    } else if (entry.isFile()) {
      const size = (await stat(file)).size; files++; bytes += size;
      if (entry.name.endsWith(".json")) largestJsonBytes = Math.max(largestJsonBytes, size);
    }
  }
  return { files, bytes, largestJsonBytes };
}

function semanticGroups(setup: PodcastSetup): { groups: PodcastGroup[]; participants: PodcastParticipant[] } {
  const participants: PodcastParticipant[] = [{ id: "alice", name: "Alice" }, { id: "bob", name: "Bob" }];
  const groups = setup.groups.map((entry) => {
    const assets = entry.assetIds.map((id) => setup.analysis.assets.find((asset) => asset.id === id)!).filter(Boolean);
    const first = assets[0];
    if (first.kind === "video") return { ...entry, role: "camera" as const, framing: "other" as const, participantIds: [], audioBindings: [] };
    const participantId = /alice/i.test(first.name) ? "alice" : "bob";
    return {
      ...entry, role: "dialogue" as const, audioMode: "isolated" as const,
      participantIds: [participantId], audioParticipantIds: [participantId],
      audioBindings: assets.flatMap((asset) => (asset.streams ?? []).filter((stream) => stream.kind === "audio").flatMap((stream) =>
        // The stereo fixture's channel 1 is an independent decoy and has no participant assignment.
        Array.from({ length: stream.channels ?? 1 }, (_, channel) => channel === 0 ? ({ assetId: asset.id, streamIndex: stream.index, channel, participantId }) : undefined).filter((binding): binding is NonNullable<typeof binding> => Boolean(binding)),
      )),
    };
  });
  return { groups, participants };
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function progressOnStageChanges() {
  let prior = "";
  return (event: { phase: string; message: string }) => {
    const current = `${event.phase}: ${event.message}`;
    if (current !== prior) { console.log(`[native] ${current}`); prior = current; }
  };
}

function timingErrors(manifest: FixtureManifest, setup: PodcastSetup) {
  return manifest.sources.map((source) => {
    const asset = setup.analysis.assets.find((candidate) => candidate.mediaId === source.mediaId);
    const placement = setup.placements.find((candidate) => candidate.assetId === asset?.id);
    if (!asset || !placement) return { sourceId: source.id, status: "missing" };
    const sourceTimes = [...new Set([0, 0.5, source.durationSeconds * 0.25, source.durationSeconds * 0.5, source.durationSeconds - 0.5])].filter((time) => time >= 0 && time <= source.durationSeconds);
    const errors = sourceTimes.map((sourceSeconds) => {
      const actual = placement.mapping.scale * sourceSeconds + placement.mapping.offsetSeconds;
      const expected = source.mapping.scale * sourceSeconds + source.mapping.offsetSeconds;
      const errorMs = (actual - expected) * 1_000;
      return { sourceSeconds, expectedProjectSeconds: expected, actualProjectSeconds: actual, errorMs, errorFramesAt25Fps: errorMs / 40 };
    });
    return { sourceId: source.id, status: placement.status, expected: source.mapping, actual: placement.mapping, driftErrorPpm: (placement.mapping.scale - source.mapping.scale) * 1_000_000, maxAbsoluteErrorMs: Math.max(...errors.map((point) => Math.abs(point.errorMs))), points: errors };
  });
}

async function runCold(manifest: FixtureManifest) {
  const profile = profilePath();
  try {
    await stat(path.join(outputPath(), "native-run-state.json"));
    throw new Error("Cold run evidence already exists; choose a fresh synthetic fixture directory.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const registry = new ManagedAssetRegistry(path.join(profile, "media"));
  for (const source of manifest.sources) await registry.referenceOriginal(source.mediaId, source.path);
  const queue = new HeavyJobQueue();
  const audio = createAudio(registry, queue);
  const service = new PodcastNativeService(path.join(profile, "podcast"), registry, audio);
  const setupId = randomUUID();
  const controller = new AbortController();
  const stageTimes: Record<string, number> = {};
  let start = performance.now();
  let setup = await service.inspect({ projectId: "synthetic-full-hour-verification", mediaIds: manifest.sources.map((source) => source.mediaId), createSetupId: setupId, requestId: randomUUID() }, controller.signal);
  stageTimes.inspectSeconds = (performance.now() - start) / 1_000;
  const intended = semanticGroups(setup);
  start = performance.now();
  setup = await service.revise({ setupId, groups: intended.groups, participants: intended.participants });
  stageTimes.groupingAndRevisionSeconds = (performance.now() - start) / 1_000;
  start = performance.now();
  setup = await service.analyze(setupId, randomUUID(), controller.signal, progressOnStageChanges());
  stageTimes.packetScanAndNativePipelineSeconds = (performance.now() - start) / 1_000;
  const sourceIdentityChecks = manifest.sources.map((source) => {
    const asset = setup.analysis.assets.find((candidate) => candidate.mediaId === source.mediaId);
    return { sourceId: source.id, manifestSha256: source.sha256, analyzedSha256: asset?.sourceDigest, matches: asset?.sourceDigest === source.sha256 };
  });
  expect(sourceIdentityChecks.every((entry) => entry.matches)).toBe(true);
  const cache = await directoryBytes(path.join(profile, "podcast", "analysis"));
  await writeJson(path.join(outputPath(), "native-run-state.json"), { setupId, projectId: setup.projectId, profile, completedAt: new Date().toISOString() });
  const challengeManifest = JSON.parse(await readFile(path.join(fixturePath(), "challenges", "manifest.json"), "utf8")) as ChallengeManifest;
  for (const source of challengeManifest.challengeSources) await registry.referenceOriginal(source.mediaId, source.path);
  const challengeSetupId = randomUUID();
  const challengeSources = [...challengeManifest.challengeSources].sort((a, b) => Number(b.id === "repeat-reference") - Number(a.id === "repeat-reference"));
  let challengeSetup = await service.inspect({ projectId: "synthetic-correlation-challenges", mediaIds: challengeSources.map((source) => source.mediaId), createSetupId: challengeSetupId, requestId: randomUUID() }, controller.signal);
  const challengeGroups: PodcastGroup[] = challengeSetup.analysis.assets.map((asset) => ({
    id: `challenge-${asset.id}`, name: asset.name, kind: "audio", role: "other", confidence: "high", assetIds: [asset.id], warnings: [],
  }));
  challengeSetup = await service.revise({ setupId: challengeSetupId, groups: challengeGroups, participants: [] });
  challengeSetup = await service.analyze(challengeSetupId, randomUUID(), controller.signal, () => undefined);
  const challengeNative = {
    assets: challengeSetup.analysis.assets.map((asset) => ({ id: challengeManifest.challengeSources.find((source) => source.mediaId === asset.mediaId)?.id, channels: challengeSetup.channels.filter((channel) => channel.assetId === asset.id).map((channel) => ({ channel: channel.channel, usable: channel.usable, rms: channel.rms })) })),
    placements: challengeSetup.placements.map((placement) => ({ assetId: placement.assetId, status: placement.status, mapping: placement.mapping, reviewReason: placement.reviewReason })),
    edges: challengeSetup.edges.map((edge) => ({ a: edge.a, b: edge.b, channelA: edge.channelA, channelB: edge.channelB, status: edge.status, reason: edge.reason })),
    metrics: challengeSetup.metrics,
  };
  const report = {
    mode: "native-cold", elapsedSeconds: Object.values(stageTimes).reduce((sum, value) => sum + value, 0), stageTimes,
    nativeMetrics: setup.metrics, setupState: setup.state, assets: setup.analysis.assets.length, sourceIdentityChecks,
    groupAssignments: setup.groups.map((group) => ({ name: group.name, role: group.role, assetIds: group.assetIds, audioBindings: group.audioBindings })),
    includedAssetIds: setup.groups.flatMap((group) => group.assetIds), placements: timingErrors(manifest, setup),
    cache, reader: { ...metrics }, profileIsSyntheticOnly: true,
    cacheTemperature: "Podcast analysis cache was empty before this pass; OS page cache was not flushed or described as cold.", challengeNative,
  };
  await writeJson(path.join(outputPath(), "native-cold.json"), report);
  expect(setup.analysis.assets).toHaveLength(manifest.sources.length);
}

async function runWarm(manifest: FixtureManifest) {
  const state = JSON.parse(await readFile(path.join(outputPath(), "native-run-state.json"), "utf8")) as { setupId: string };
  const registry = new ManagedAssetRegistry(path.join(profilePath(), "media"));
  const queue = new HeavyJobQueue();
  const audio = createAudio(registry, queue);
  const service = new PodcastNativeService(path.join(profilePath(), "podcast"), registry, audio);
  let getStart = performance.now();
  let setup = await service.get(state.setupId);
  const loadSetupSeconds = (performance.now() - getStart) / 1_000;
  const controller = new AbortController();
  const start = performance.now();
  const result = await analyzeLegacyPodcastSetup({ setup, registry, audio, cacheDir: path.join(profilePath(), "podcast", "analysis"), signal: controller.signal, onProgress: progressOnStageChanges() });
  setup = result.setup;
  const pipelineSeconds = (performance.now() - start) / 1_000;
  const cache = await directoryBytes(path.join(profilePath(), "podcast", "analysis"));
  const report = {
    mode: "native-warm-reopen", loadSetupSeconds, pipelineSeconds, nativeMetrics: result.metrics,
    setupState: setup.state, placements: timingErrors(manifest, setup), cache, reader: { ...metrics },
    notes: ["New registry/service instances and a fresh Vitest process; persistent feature and match caches reused.", "Packet scan is not repeated in this warm pipeline-only pass."],
  };
  await writeJson(path.join(outputPath(), "native-warm.json"), report);
  expect(result.metrics.cacheHits).toBeGreaterThan(0);
}

async function runCorrected(manifest: FixtureManifest) {
  const state = JSON.parse(await readFile(path.join(outputPath(), "native-run-state.json"), "utf8")) as { setupId: string };
  const registry = new ManagedAssetRegistry(path.join(profilePath(), "media"));
  const queue = new HeavyJobQueue();
  const audio = createAudio(registry, queue);
  const service = new PodcastNativeService(path.join(profilePath(), "podcast"), registry, audio);
  const before = await service.get(state.setupId);
  const beforeGroups = before.groups.map((group) => ({ name: group.name, role: group.role, audioBindings: group.audioBindings }));
  const beforePlacements = structuredClone(before.placements);
  const intended = semanticGroups(before);
  const reviseStarted = performance.now();
  const revised = await service.revise({ setupId: state.setupId, groups: intended.groups, participants: intended.participants });
  const reviseSeconds = (performance.now() - reviseStarted) / 1_000;
  const controller = new AbortController();
  const analyzeStarted = performance.now();
  const analyzed = await service.analyze(state.setupId, randomUUID(), controller.signal, progressOnStageChanges());
  const analyzeSeconds = (performance.now() - analyzeStarted) / 1_000;
  const proposed = analyzed.analysisProposal?.result;
  const afterPlacements = proposed?.placements ?? analyzed.placements;
  const afterChannels = proposed?.channels ?? analyzed.channels;
  const parity = beforePlacements.flatMap((old) => {
    const next = afterPlacements.find((candidate) => candidate.assetId === old.assetId);
    return next ? [{ assetId: old.assetId, offsetDeltaMs: (next.mapping.offsetSeconds - old.mapping.offsetSeconds) * 1_000, scaleDeltaPpm: (next.mapping.scale - old.mapping.scale) * 1_000_000, beforeStatus: old.status, afterStatus: next.status }] : [];
  });
  const sourceIdentityChecks = manifest.sources.map((source) => {
    const asset = analyzed.analysis.assets.find((candidate) => candidate.mediaId === source.mediaId);
    const prior = before.analysis.assets.find((candidate) => candidate.mediaId === source.mediaId);
    return { sourceId: source.id, sourceIdMatches: asset?.sourceId === prior?.sourceId, digestMatches: asset?.sourceDigest === source.sha256 };
  });
  const featureCacheKeyParity = before.channels.map((channel) => {
    const currentCacheKey = afterChannels.find((candidate) => candidate.id === channel.id)?.cacheKey;
    return { channelId: channel.id, previousCacheKey: channel.cacheKey, currentCacheKey, unchanged: currentCacheKey === channel.cacheKey };
  });
  const report = {
    mode: "native-corrected-cache-reuse", reviseSeconds, packetScanAndReanalysisSeconds: analyzeSeconds,
    cacheMetrics: proposed?.metrics ?? analyzed.metrics, setupRevisionBeforeAnalyze: revised.revision, setupRevision: analyzed.revision, state: analyzed.state,
    beforeGroups, afterGroups: analyzed.groups.map((group) => ({ name: group.name, role: group.role, audioBindings: group.audioBindings })),
    unassignedBobStereoChannel: afterChannels.filter((channel) => channel.assetId === analyzed.analysis.assets.find((asset) => /MIC_BOB_STEREO/i.test(asset.name))?.id && channel.channel === 1).map((channel) => ({ streamIndex: channel.streamIndex, channel: channel.channel, usable: channel.usable, assignedParticipant: analyzed.groups.find((group) => group.assetIds.includes(channel.assetId))?.audioBindings?.find((binding) => binding.streamIndex === channel.streamIndex && binding.channel === channel.channel)?.participantId })),
    sourceIdentityChecks,
    featureCacheKeyParity,
    timingParityAgainstInitialMeasurement: { comparedPlacements: parity.length, maxOffsetDeltaMs: Math.max(0, ...parity.map((entry) => Math.abs(entry.offsetDeltaMs))), maxScaleDeltaPpm: Math.max(0, ...parity.map((entry) => Math.abs(entry.scaleDeltaPpm))), rows: parity },
    proposalPlacements: timingErrors(manifest, { ...analyzed, placements: afterPlacements }),
    reader: { ...metrics }, notes: ["This is a controlled follow-up revision, not a second cold decode.", "Only channel 0 is assigned to Bob; channel 1 remains an unassigned independent decoy.", "All selected channels were still extracted and matched by the native pipeline; audioBindings govern participant routing, not feature extraction."],
  };
  await writeJson(path.join(outputPath(), "native-corrected-warm.json"), report);
  expect(analyzed.groups.some((group) => group.audioBindings?.some((binding) => binding.participantId === "bob" && binding.channel === 1))).toBe(false);
  expect(sourceIdentityChecks.every((entry) => entry.sourceIdMatches && entry.digestMatches)).toBe(true);
  expect(featureCacheKeyParity.every((entry) => entry.unchanged)).toBe(true);
  expect((proposed?.metrics?.cacheHits ?? analyzed.metrics?.cacheHits ?? 0)).toBeGreaterThan(0);
}

async function readCompactSamples(audio: NativeAudioAnalysis, sourceId: string, durationSeconds: number, sourceChannelIndex?: number) {
  const frameCount = Math.floor(durationSeconds * 1_000);
  const samples = new Float32Array(frameCount);
  const signal = new AbortController().signal;
  let at = 0, windows = 0;
  const started = performance.now();
  while (at < frameCount) {
    const durationMs = Math.min(10_000, frameCount - at);
    const window = await audio.getNativeAudioWindow(sourceId, 0, at, durationMs, signal, 1_000, 1, sourceChannelIndex);
    samples.set(window.channels[0], at); at += window.channels[0].length; windows++;
  }
  return { samples, decodeSeconds: (performance.now() - started) / 1_000, windows };
}

async function runCompact(manifest: FixtureManifest) {
  const registry = new ManagedAssetRegistry(path.join(profilePath(), "media"));
  const audio = createAudio(registry, new HeavyJobQueue());
  const state = JSON.parse(await readFile(path.join(outputPath(), "native-run-state.json"), "utf8")) as { setupId: string };
  const nativeSetup = JSON.parse(await readFile(path.join(profilePath(), "podcast", "setups", `${state.setupId}.json`), "utf8")) as PodcastSetup;
  const sources = [] as Array<{ sourceId: string; id: string; durationSeconds: number; samples: Float32Array }>;
  const sourceIdentityChecks = [] as Array<{ sourceId: string; sourceIdMatches: boolean; digestMatches: boolean }>;
  let decodeSeconds = 0, windowCount = 0;
  for (const source of manifest.sources) {
    const registered = await registry.findMedia(source.mediaId);
    if (!registered) throw new Error(`Synthetic original was not registered: ${source.id}`);
    const analyzedAsset = nativeSetup.analysis.assets.find((asset) => asset.mediaId === source.mediaId);
    const identityCheck = { sourceId: source.id, sourceIdMatches: registered.identity.assetId === analyzedAsset?.sourceId, digestMatches: registered.identity.sha256 === source.sha256 };
    sourceIdentityChecks.push(identityCheck);
    if (!identityCheck.sourceIdMatches || !identityCheck.digestMatches) throw new Error(`Compact path did not resolve the same registered source bytes as native analysis: ${source.id}`);
    const data = await readCompactSamples(audio, registered.identity.assetId, source.durationSeconds);
    sources.push({ sourceId: registered.identity.assetId, id: source.id, durationSeconds: source.durationSeconds, samples: data.samples });
    decodeSeconds += data.decodeSeconds; windowCount += data.windows;
    console.log(`[compact] decoded full 1 kHz input: ${source.id} (${data.windows} bounded windows)`);
  }
  const reference = sources.find((source) => source.id === "mic-alice")!;
  const pairResults = [];
  let analysisSeconds = 0;
  for (const target of sources) {
    if (target.id === reference.id) continue;
    const duration = Math.min(reference.samples.length, target.samples.length) / 1_000;
    const options = { blockSeconds: Math.min(5, Math.max(1, duration / 3)), intervalSeconds: 300, maxOffsetSeconds: Math.max(0.05, Math.min(30, (duration - 1) / 2)), analysisSampleRate: 400 };
    const start = performance.now();
    const model = analyzeMulticamDrift(reference.samples, target.samples, 1_000, options);
    analysisSeconds += (performance.now() - start) / 1_000;
    const sourceFact = manifest.sources.find((entry) => entry.id === target.id)!;
    const expectedOffset = -sourceFact.mapping.offsetSeconds / sourceFact.mapping.scale;
    const expectedSlope = 1 / sourceFact.mapping.scale - 1;
    pairResults.push({
      targetId: target.id, model, expectedCompactModel: { interceptSeconds: expectedOffset, secondsPerSecond: expectedSlope, partsPerMillion: expectedSlope * 1_000_000 },
      interceptErrorMs: (model.interceptSeconds - expectedOffset) * 1_000,
      driftErrorPpm: (model.partsPerMillion - expectedSlope * 1_000_000),
      maxOffsetSeconds: options.maxOffsetSeconds, durationSeconds: duration,
      status: model.confidence > 0.2 && Math.abs(model.interceptSeconds - expectedOffset) < 0.05 ? "within-50ms" : "unresolved-or-outside-search",
    });
  }

  const bob = manifest.sources.find((source) => source.id === "mic-bob")!;
  const bobAsset = await registry.findMedia(bob.mediaId);
  if (!bobAsset) throw new Error("Bob stereo microphone is unavailable.");
  const selectedChannel = await readCompactSamples(audio, bobAsset.identity.assetId, bob.durationSeconds, 0);
  decodeSeconds += selectedChannel.decodeSeconds;
  const bobChannelModel = analyzeMulticamDrift(reference.samples, selectedChannel.samples, 1_000, { blockSeconds: 5, intervalSeconds: 300, maxOffsetSeconds: 30, analysisSampleRate: 400 });
  const challengeManifest = JSON.parse(await readFile(path.join(fixturePath(), "challenges", "manifest.json"), "utf8")) as ChallengeManifest;
  const challengeBuffers = new Map<string, Float32Array>();
  for (const source of challengeManifest.challengeSources) {
    const registered = await registry.findMedia(source.mediaId);
    if (!registered) throw new Error(`Synthetic challenge original was not registered: ${source.id}`);
    const data = await readCompactSamples(audio, registered.identity.assetId, source.durationSeconds);
    challengeBuffers.set(source.id, data.samples); decodeSeconds += data.decodeSeconds; windowCount += data.windows;
  }
  const challengeOptions = { blockSeconds: 5, intervalSeconds: 300, maxOffsetSeconds: 30, analysisSampleRate: 400 };
  const challengeAnalysisStart = performance.now();
  const silentModel = analyzeMulticamDrift(reference.samples, challengeBuffers.get("silence")!, 1_000, challengeOptions);
  const repeatModel = analyzeMulticamDrift(challengeBuffers.get("repeat-reference")!, challengeBuffers.get("repeat-target")!, 1_000, challengeOptions);
  const unmatchedModel = analyzeMulticamDrift(reference.samples, challengeBuffers.get("unmatched")!, 1_000, challengeOptions);
  analysisSeconds += (performance.now() - challengeAnalysisStart) / 1_000;

  const report = {
    mode: process.env.TAKEOVER_HOUR_MODE, decodeSeconds, analysisSeconds, totalSeconds: decodeSeconds + analysisSeconds,
    sourceIdentityChecks,
    comparisonScope: "The existing worker correlation function and production options run directly over the same original signals at 1 kHz. The current panel uses this worker for camera angles and does not use participant microphones as a reference; this is an algorithm comparison, not a claim that the full panel workflow already provides that behavior.",
    decodedSources: sources.length, windowCount, currentPanelChannelBehavior: "The current MultiCameraPanel calls getCompactSourceBuffer without a channel selector; the production default therefore uses FFmpeg mono downmix for stereo sources.",
    pairResults, stereoChannelCheck: { targetId: "mic-bob", currentDefault: pairResults.find((entry) => entry.targetId === "mic-bob"), selectedChannelZero: bobChannelModel, selectedChannelReadSeconds: selectedChannel.decodeSeconds, selectedChannelWindows: selectedChannel.windows },
    challengeResults: { silence: { model: silentModel, status: silentModel.confidence > 0.2 ? "unexpected-confidence" : "unresolved" }, repeatedContent: { model: repeatModel, status: "compact-model-has-no-ambiguity-status" }, unrelatedAperiodic: { model: unmatchedModel, status: unmatchedModel.confidence > 0.2 ? "candidate-needs-independent-review" : "unresolved" } },
    reader: { ...metrics }, cache: { applicationCache: false, note: "Compact worker receives full 1 kHz arrays; no compact analysis cache is present in this route." },
    resourceBound: { requestedWindowMaxMs: 10_000, outputMaxBytesObserved: metrics.maxNativePayloadBytes, childConcurrency: metrics.maxActiveChildren, sampledChildPeakRssBytes: metrics.peakChildRssBytes, peakProcessRssBytes: metrics.peakProcessRssBytes },
  };
  await writeJson(path.join(outputPath(), `${process.env.TAKEOVER_HOUR_MODE}.json`), report);
  expect(pairResults).toHaveLength(manifest.sources.length - 1);
}

afterEach(() => {
  if (rssTimer) clearInterval(rssTimer);
  rssTimer = undefined;
});

describe.skipIf(!enabled)("takeover full-hour verification", () => {
  fixtureTest("runs the selected native or compact benchmark mode", async () => {
    const manifest = await readManifest();
    const mode = process.env.TAKEOVER_HOUR_MODE;
    await mkdir(outputPath(), { recursive: true });
    rssTimer = setInterval(() => { void sampleChildRss(); }, 750);
    if (mode === "native-cold") await runCold(manifest);
    else if (mode === "native-corrected") await runCorrected(manifest);
    else if (mode === "native-warm") await runWarm(manifest);
    else if (mode === "compact-cold" || mode === "compact-warm") await runCompact(manifest);
    else throw new Error("Set TAKEOVER_HOUR_MODE to native-cold, native-corrected, native-warm, compact-cold, or compact-warm.");
    await sampleChildRss();
    expect(metrics.maxRequestedWindowMs).toBeLessThanOrEqual(10_000);
    expect(metrics.maxActiveChildren).toBeLessThanOrEqual(1);
  }, 6 * 60 * 60 * 1_000);
});
