import { readFile } from "node:fs/promises";
import type { PodcastAsset, PodcastStreamFacts, PodcastSyncChannel } from "../../../../../../packages/core/src/lickety/podcast-types";
import type { RegisteredAsset } from "../../../../../../packages/core/src/lickety/types";
import { NativeAudioAnalysis } from "../audio-analysis";
import { ANALYSIS_RATE, FEATURE_VERSION, HOP, fingerprintBlock, type Hash } from "./dsp";
import { audioTimestampBlockers } from "./legacy/regions";
import { cachedPodcastWork, podcastCacheDigest } from "./work-cache";

const BLOCK_FRAMES = 1024 * HOP;
const CONTEXT_FRAMES = 128 * HOP;
const WINDOW_FRAMES = ANALYSIS_RATE * 10;
const DECODER_VERSION = "native-bounded-window-pan-preroll-input-cap-timestamp-fill-v3";
const WAVEFORM_STAGE = "channel-waveform-v1";
export interface PodcastProgressUpdate { phase: "inspect" | "decode" | "features" | "match" | "solve" | "done"; completed: number; total: number; message: string }
export interface PodcastAssetRegistry { findMedia(mediaId: string): Promise<RegisteredAsset | undefined> }
interface Features { version: string; cacheKey: string; frames: number; hashes: Hash[]; min: number[]; max: number[]; rms: number; clippedFraction: number }
export interface ChannelWork { channel: PodcastSyncChannel; audioOrdinal: number; featureFile: string; featureCacheKey: string; receipt: import("./legacy/types").DecodeReceipt }

const waitTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** startMs is a seek offset from the container presentation origin, not a decoded-stream frame offset. */
export async function boundedPcm(audio: NativeAudioAnalysis, sourceId: string, audioOrdinal: number, sourceChannelIndex: number, startMs: number, frameCount: number, signal: AbortSignal): Promise<Float32Array> {
  if (!Number.isFinite(startMs) || startMs < 0 || frameCount < 1) return new Float32Array();
  const result = new Float32Array(frameCount);
  let done = 0;
  while (done < frameCount) {
    signal.throwIfAborted();
    const frames = Math.min(WINDOW_FRAMES, frameCount - done);
    const durationMs = (frames * 1000) / ANALYSIS_RATE;
    const window = await audio.getNativeAudioWindow(sourceId, audioOrdinal, startMs + (done * 1000) / ANALYSIS_RATE, durationMs, signal, ANALYSIS_RATE, 1, sourceChannelIndex);
    if (window.channels[0].length !== frames) throw new Error(`Native decoder returned an incomplete ${durationMs.toFixed(3)} ms audio window. Timing evidence was not saved.`);
    result.set(window.channels[0], done);
    done += frames;
    await waitTurn();
  }
  return result;
}

function validFeatures(value: unknown, cacheKey: string): value is Features {
  if (!value || typeof value !== "object") return false;
  const f = value as Features;
  return f.version === FEATURE_VERSION && f.cacheKey === cacheKey && Number.isSafeInteger(f.frames) && f.frames >= 0 && Array.isArray(f.hashes) && Array.isArray(f.min) && Array.isArray(f.max) && f.min.length === Math.ceil(f.frames / HOP) && f.max.length === f.min.length && Number.isFinite(f.rms);
}

export async function extractFeatures(args: {
  asset: PodcastAsset; stream: PodcastStreamFacts; sourceId: string; sha256: string; audioOrdinal: number; streamIndex: number; channelIndex: number;
  audio: NativeAudioAnalysis; directory: string; signal: AbortSignal; onProgress: (event: PodcastProgressUpdate) => void;
}): Promise<{ work: ChannelWork; features: Features; cacheHit: boolean; decodeSeconds: number }> {
  const { asset, stream, sourceId, sha256, audioOrdinal, streamIndex, channelIndex, audio, directory, signal, onProgress } = args;
  const frames = Math.max(0, Math.round((stream.durationSeconds ?? asset.durationSeconds) * ANALYSIS_RATE));
  const containerStartSeconds = asset.containerStartSeconds ?? 0;
  const firstPTSSeconds = stream.timestampStatus === "continuous" ? stream.startSeconds : undefined;
  const startSeconds = firstPTSSeconds ?? stream.startSeconds ?? containerStartSeconds;
  const seekOriginSeconds = startSeconds - containerStartSeconds;
  if (seekOriginSeconds < -0.5 / ANALYSIS_RATE) throw new Error(`${asset.name}: audio stream starts before the verified container presentation origin; bounded source timing is unavailable.`);
  const discontinuities = stream.discontinuities ?? [];
  const identity = { sha256, sourceId, streamIndex, channelIndex, frames, startSeconds, containerStartSeconds, seekOriginSeconds,
    timestampStatus: stream.timestampStatus, discontinuities, sampleRate: ANALYSIS_RATE, decoder: DECODER_VERSION, featureVersion: FEATURE_VERSION };
  const key = podcastCacheDigest({ version: 1, stage: "channel-features", identity });
  let measuredDecodeSeconds = 0;
  const cached = await cachedPodcastWork(directory, "channel-features", identity, async () => {
    const hashes: Hash[] = [], min: number[] = [], max: number[] = [];
    let energy = 0, clipped = 0, measuredFrames = 0;
    const started = performance.now();
    for (let start = 0; start < frames; start += BLOCK_FRAMES) {
      signal.throwIfAborted();
      const from = Math.max(0, start - CONTEXT_FRAMES), to = Math.min(frames, start + BLOCK_FRAMES + CONTEXT_FRAMES);
      const pcm = await boundedPcm(audio, sourceId, audioOrdinal, channelIndex, Math.max(0, seekOriginSeconds) * 1000 + (from * 1000) / ANALYSIS_RATE, to - from, signal);
      for (const [t, hash] of fingerprintBlock(pcm)) {
        const globalFrame = t * HOP + from;
        if (globalFrame < start || globalFrame >= start + BLOCK_FRAMES) continue;
        const gap = discontinuities.find((item) => Math.abs(globalFrame - item.decodedFrame) < 4 * ANALYSIS_RATE);
        if (gap) continue;
        const prior = [...discontinuities].filter((item) => item.decodedFrame <= globalFrame).at(-1);
        const spanFrame = prior?.decodedFrame ?? 0, spanPTS = prior?.atSeconds ?? startSeconds;
        const sourceFrame = (spanPTS - startSeconds) * ANALYSIS_RATE + globalFrame - spanFrame;
        if (sourceFrame >= 0) hashes.push([sourceFrame / HOP, hash]);
      }
      for (let i = start; i < Math.min(frames, start + BLOCK_FRAMES); i += HOP) {
        let lo = 1, hi = -1;
        for (let j = i; j < Math.min(i + HOP, frames); j++) {
          const sample = pcm[j - from];
          if (!Number.isFinite(sample)) throw new Error("Native audio reader returned non-finite samples.");
          lo = Math.min(lo, sample); hi = Math.max(hi, sample); energy += sample * sample; measuredFrames++;
          if (Math.abs(sample) >= 0.999) clipped++;
        }
        min.push(lo); max.push(hi);
      }
      onProgress({ phase: "features", completed: Math.min(frames, start + BLOCK_FRAMES), total: frames, message: `Fingerprinting ${asset.name}, stream ${streamIndex}, channel ${channelIndex + 1}` });
      await waitTurn();
    }
    measuredDecodeSeconds = (performance.now() - started) / 1000;
    return { version: FEATURE_VERSION, cacheKey: key, frames, hashes, min, max, rms: Math.sqrt(energy / Math.max(1, measuredFrames)), clippedFraction: clipped / Math.max(1, measuredFrames) } satisfies Features;
  }, signal, (value): value is Features => validFeatures(value, key) && value.frames === frames);
  const features = cached.value;
  const waveformIdentity = { featureCacheKey: key, frames: features.frames };
  await cachedPodcastWork(directory, WAVEFORM_STAGE, waveformIdentity, async () => ({
    version: 1 as const, featureCacheKey: key, frames: features.frames, min: features.min, max: features.max,
  }), signal, (value): value is { version: 1; featureCacheKey: string; frames: number; min: number[]; max: number[] } => {
    if (!value || typeof value !== "object") return false;
    const row = value as { version?: number; featureCacheKey?: string; frames?: number; min?: unknown; max?: unknown };
    return row.version === 1 && row.featureCacheKey === key && row.frames === features.frames && Array.isArray(row.min) && Array.isArray(row.max) && row.min.length === Math.ceil(features.frames / HOP) && row.max.length === row.min.length && row.min.every(Number.isFinite) && row.max.every(Number.isFinite);
  });
  const receipt = { version: 1 as const, decoder: DECODER_VERSION, audioTrackOrdinal: audioOrdinal, channels: stream.channels ?? 1, sampleRate: ANALYSIS_RATE, nativeSampleRate: stream.sampleRate ?? ANALYSIS_RATE, firstPTSSeconds: startSeconds, trackStartSeconds: startSeconds, trackDurationSeconds: frames / ANALYSIS_RATE, frames, decodedDurationSeconds: frames / ANALYSIS_RATE, discontinuities };
  const audioBlockers = audioTimestampBlockers(receipt);
  const work: ChannelWork = { channel: { id: `${asset.id}:${streamIndex}:${channelIndex}`, assetId: asset.id, sourceId, streamIndex, channel: channelIndex, cacheKey: key, usable: features.rms > 1e-5 && features.hashes.length >= 10 && audioBlockers.length === 0, rms: features.rms, sampleRate: ANALYSIS_RATE, frames, ...(stream.startSeconds !== undefined ? { firstPTSSeconds: stream.startSeconds } : {}), timestampStatus: stream.timestampStatus === "continuous" || stream.timestampStatus === "discontinuous" || stream.timestampStatus === "unsupported" ? stream.timestampStatus : "unknown", discontinuities }, audioOrdinal, featureFile: cached.file, featureCacheKey: key, receipt };
  return { work, features, cacheHit: cached.cacheHit, decodeSeconds: cached.cacheHit ? 0 : measuredDecodeSeconds };
}

const featureMemory = new Map<string, { features: Features; bytes: number }>();
let featureMemoryBytes = 0;
export async function loadFeatures(file: string, expectedCacheKey: string, expectedFeatureCacheKey: string): Promise<Features> {
  const cached = featureMemory.get(file);
  if (cached) { featureMemory.delete(file); featureMemory.set(file, cached); return cached.features; }
  const json = await readFile(file, "utf8"), saved = JSON.parse(json) as { key?: string; value?: unknown; checksum?: string }, features = saved.value as Features, bytes = json.length * 8;
  if (saved.key !== expectedFeatureCacheKey || saved.checksum !== podcastCacheDigest(features) || !validFeatures(features, expectedCacheKey)) throw new Error("Completed podcast feature cache failed checksum or schema validation.");
  while (featureMemory.size && featureMemoryBytes + bytes > 16 * 1024 ** 2) {
    const oldest = featureMemory.keys().next().value!;
    featureMemoryBytes -= featureMemory.get(oldest)!.bytes; featureMemory.delete(oldest);
  }
  if (bytes <= 16 * 1024 ** 2) { featureMemory.set(file, { features, bytes }); featureMemoryBytes += bytes; }
  return features;
}
