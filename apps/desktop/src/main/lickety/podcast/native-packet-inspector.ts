import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { stat } from "node:fs/promises";
import { heavyQueue } from "../media-jobs";
import { resolveMediaInspectorPath } from "../../sidecar/media-inspector-path";
import type { PodcastStreamFacts, RationalRate } from "../../../../../../packages/core/src/lickety/podcast-types";

export interface PacketTiming {
  timestampStatus: "continuous" | "discontinuous" | "unsupported";
  firstPTSSeconds?: number;
  durationSeconds?: number;
  packetCount: number;
  discontinuities: Array<{ atSeconds: number; deltaSeconds: number; decodedFrame: number }>;
  reason: string;
}

export interface NativePodcastInspection {
  streams: PodcastStreamFacts[];
  warnings: string[];
  containerStartSeconds?: number;
  metadata: { duration: number; width: number; height: number; frameRate: number; codec: string; sampleRate: number; channels: number; fileSize: number; hasVideo: boolean; hasAudio: boolean };
  sourceMetadata: { creationTime?: string; timecode?: string; reel?: string; bwfTimeReferenceSamples?: string };
}

export function packetTimingSummary(count: number, firstPTS: number, lastPTS: number, irregularDurations: number, nominalSeconds: number) {
  const gap = Math.abs((lastPTS - firstPTS + nominalSeconds) - count * nominalSeconds);
  const bad = !count || !Number.isFinite(firstPTS) || irregularDurations > 0 || gap > Math.max(0.00002, nominalSeconds * 0.25);
  return { count, firstPTS, lastPTS, irregularDurations, timestampStatus: bad ? "discontinuous" as const : "continuous" as const,
    reason: bad ? "Packet cadence or duration differs from the declared constant rate." : "Presented packet cadence agrees with the declared constant rate; no picture frames were decoded." };
}

/** Video packet parity port: decoder-only discard packets never become pictures. */
export class VideoPacketScan {
  private count = 0; private first = Infinity; private last = -Infinity; private irregular = 0;
  private discarded = 0; private short: { pts: number; end: number } | undefined;
  constructor(private nominal: number, private streamEnd?: number) {}
  add(pts: number, duration: number, flags = "") {
    if (flags.includes("D")) { this.discarded++; return; }
    if (Number.isFinite(pts)) { this.count++; this.first = Math.min(this.first, pts); this.last = Math.max(this.last, pts); }
    else this.irregular++;
    if (!Number.isFinite(duration) || Math.abs(duration - this.nominal) > 0.00001) {
      this.irregular++;
      if (duration > 0 && duration < this.nominal) this.short = { pts, end: pts + duration };
    }
  }
  finish() {
    const shortened = Boolean(this.irregular === 1 && this.short && this.short.pts === this.last && this.streamEnd !== undefined && Math.abs(this.short.end - this.streamEnd) < 0.00002);
    return { ...packetTimingSummary(this.count, this.first, this.last, this.irregular - (shortened ? 1 : 0), this.nominal), discardedPackets: this.discarded, shortenedTerminalPacket: shortened };
  }
}

class AudioPacketScan {
  private first = Infinity; private previousPTS = -Infinity; private previousStep = 0; private packetCount = 0; private decodedDuration = 0;
  private trimmedSeconds = 0;
  private discontinuities: PacketTiming["discontinuities"] = [];
  constructor(private sampleRate: number) {}
  add(pts: number, duration: number, flags = "", skipSamples = 0, discardPadding = 0) {
    if (flags.includes("D")) return;
    if (!Number.isFinite(pts) || !Number.isFinite(this.sampleRate) || this.sampleRate <= 0) return;
    if (!Number.isFinite(this.previousPTS)) this.trimmedSeconds += Math.max(0, skipSamples) / this.sampleRate;
    this.trimmedSeconds += Math.max(0, discardPadding) / this.sampleRate;
    this.first = Math.min(this.first, pts + Math.max(0, skipSamples) / this.sampleRate);
    if (Number.isFinite(this.previousPTS)) {
      const delta = pts - this.previousPTS;
      const expected = this.previousStep || (Number.isFinite(duration) && duration > 0 ? duration : delta);
      const gap = delta - expected;
      if (Math.abs(gap) > Math.max(1 / this.sampleRate, expected * 0.25)) this.discontinuities.push({ atSeconds: pts, deltaSeconds: gap, decodedFrame: Math.round(this.decodedDuration * this.sampleRate) });
      if (expected > 0) this.decodedDuration += expected;
      if (Math.abs(gap) <= Math.max(1 / this.sampleRate, expected * 0.25) && delta > 0) this.previousStep = delta;
    } else if (Number.isFinite(duration) && duration > 0) {
      this.previousStep = duration;
    }
    this.previousPTS = pts; this.packetCount++;
    if (Number.isFinite(duration) && duration > 0) this.previousStep = duration;
  }
  finish() {
    const status = !this.packetCount ? "unsupported" as const : this.discontinuities.length ? "discontinuous" as const : "continuous" as const;
    const durationSeconds = Math.max(0, this.decodedDuration + (this.previousStep || 0) - this.trimmedSeconds);
    return { timestampStatus: status, ...(Number.isFinite(this.first) ? { firstPTSSeconds: this.first } : {}), durationSeconds, packetCount: this.packetCount,
      discontinuities: this.discontinuities, reason: status === "continuous" ? "Presented audio packet timestamps are contiguous; decoder edit/preroll correspondence still requires source-window verification." : status === "discontinuous" ? "Audio packet timeline contains a gap or overlap; continuous mapping is not asserted." : "Audio packet timestamps could not be verified." };
  }
}

function parseRatio(value: unknown) {
  if (typeof value !== "string") return undefined;
  const [numerator, denominator] = value.split("/").map(Number);
  return Number.isInteger(numerator) && Number.isInteger(denominator) && denominator > 0 ? { numerator, denominator } : undefined;
}
export function packetOriginToleranceSeconds(timeBase?: RationalRate, sampleRate?: number) {
  return timeBase ? 2 * timeBase.numerator / timeBase.denominator : 1 / (sampleRate || 8000);
}
function parseFinite(value: unknown) { const number = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN; return Number.isFinite(number) ? number : undefined; }
function parsePositive(value: unknown) { const number = parseFinite(value); return number !== undefined && number > 0 ? number : undefined; }

function runJson(binary: string, args: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    const abort = () => child.kill("SIGKILL"); signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.length > 4 * 1024 ** 2) child.kill("SIGKILL"); });
    child.stderr.on("data", (chunk: Buffer) => { error = (error + chunk.toString()).slice(-32768); });
    child.once("error", (cause) => { signal.removeEventListener("abort", abort); reject(cause); });
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else if (code !== 0) reject(new Error(`Native stream inspection failed: ${error.slice(-2000)}`));
      else { try { resolve(JSON.parse(output) as Record<string, unknown>); } catch (cause) { reject(new Error("Native stream inspector returned invalid metadata.", { cause })); } }
    });
  });
}

async function inspectUnlocked(sourcePath: string, signal: AbortSignal, packetScan: boolean): Promise<NativePodcastInspection> {
  const binary = resolveMediaInspectorPath();
  const json = await runJson(binary, ["-v", "error", "-show_streams", "-show_format", "-of", "json", sourcePath], signal);
  const file = await stat(sourcePath);
  if (!file.isFile()) throw new Error("Original is not a readable file.");
  const rawStreams = Array.isArray(json.streams) ? json.streams.filter((item): item is Record<string, unknown> => !!item && typeof item === "object") : [];
  const streams: PodcastStreamFacts[] = [];
  const warnings: string[] = [];
  for (const raw of rawStreams) {
    signal.throwIfAborted();
    const index = Number(raw.index), codecType = raw.codec_type;
    if (!Number.isInteger(index) || index < 0 || (codecType !== "audio" && codecType !== "video")) continue;
    const kind = codecType;
    const rate = parseRatio(raw.avg_frame_rate) ?? parseRatio(raw.r_frame_rate);
    const sampleRate = parsePositive(raw.sample_rate);
    const channels = Number.isInteger(Number(raw.channels)) ? Number(raw.channels) : undefined;
    const startSeconds = parseFinite(raw.start_time);
    const durationSeconds = parsePositive(raw.duration) ?? parsePositive((json.format as Record<string, unknown> | undefined)?.duration);
    const facts: PodcastStreamFacts = {
      index, kind, ...(typeof raw.codec_name === "string" ? { codec: raw.codec_name } : {}),
      ...(parseRatio(raw.time_base) ? { timeBase: parseRatio(raw.time_base) } : {}),
      ...(startSeconds !== undefined ? { startSeconds } : {}), ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(rate ? { rate, declaredRate: rate } : {}), ...(sampleRate ? { sampleRate } : {}), ...(channels !== undefined ? { channels } : {}),
      ...(typeof raw.channel_layout === "string" ? { channelLayout: raw.channel_layout } : {}),
      ...(Number.isSafeInteger(Number(raw.nb_frames)) ? { frameCount: Number(raw.nb_frames) } : {}),
      ...(Number.isInteger(Number(raw.initial_padding)) ? { initialPadding: Number(raw.initial_padding) } : {}), timestampStatus: packetScan ? "unknown" : "not-scanned",
    };
    streams.push(facts);
    if (!packetScan) continue;
    const scanner = kind === "video" && rate ? new VideoPacketScan(rate.denominator / rate.numerator, startSeconds !== undefined && durationSeconds !== undefined ? startSeconds + durationSeconds : undefined) : kind === "audio" && sampleRate ? new AudioPacketScan(sampleRate) : undefined;
    if (!scanner) { facts.timestampStatus = "unsupported"; warnings.push(`Stream ${index} has no usable native rate for packet verification.`); continue; }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, ["-v", "error", "-select_streams", String(index), "-show_packets", "-show_entries", "packet=pts_time,duration_time,flags:packet_side_data=side_data_type,skip_samples,discard_padding", "-of", "csv=p=0", sourcePath], { stdio: ["ignore", "pipe", "pipe"] });
      let error = ""; const abort = () => child.kill("SIGKILL"); signal.addEventListener("abort", abort, { once: true });
      child.stderr.on("data", (chunk: Buffer) => { error = (error + chunk.toString()).slice(-32768); });
      const settled = new Promise<void>((done, fail) => { child.once("error", fail); child.once("close", (code) => code === 0 ? done() : fail(new Error(error || `Packet scan failed for stream ${index}.`))); });
      const settledResult = settled.then(() => undefined, (cause) => cause as Error);
      (async () => {
        try {
          for await (const line of createInterface({ input: child.stdout })) {
            signal.throwIfAborted();
            const values = line.split(","), [ptsText, durationText, flags = ""] = values;
            const sideData = values.indexOf("Skip Samples");
            const skipSamples = sideData >= 0 ? Number(values[sideData + 1]) || 0 : 0;
            const discardPadding = sideData >= 0 ? Number(values[sideData + 2]) || 0 : 0;
            scanner.add(Number(ptsText), Number(durationText), flags, skipSamples, discardPadding);
          }
          const failure = await settledResult; if (failure) throw failure;
          signal.removeEventListener("abort", abort); resolve();
        } catch (cause) { child.kill("SIGKILL"); signal.removeEventListener("abort", abort); reject(cause); }
      })();
    });
    const rawSummary = scanner.finish();
    const summary: PacketTiming = "firstPTS" in rawSummary ? {
      timestampStatus: rawSummary.timestampStatus, firstPTSSeconds: rawSummary.firstPTS, packetCount: rawSummary.count,
      discontinuities: [], reason: rawSummary.reason,
    } : rawSummary;
    facts.timestampStatus = summary.timestampStatus;
    if (summary.firstPTSSeconds !== undefined) {
      const timeBase = parseRatio(raw.time_base);
      const tolerance = packetOriginToleranceSeconds(timeBase, sampleRate);
      if (kind === "audio" && startSeconds !== undefined && Math.abs(summary.firstPTSSeconds - startSeconds) <= tolerance) facts.startSeconds = startSeconds;
      else if (kind === "audio" && startSeconds !== undefined) {
        facts.timestampStatus = "unsupported";
        warnings.push(`Stream ${index}: skip-sample packet timing does not reconcile with the container presentation origin.`);
      } else facts.startSeconds = summary.firstPTSSeconds;
    }
    if (summary.durationSeconds !== undefined && summary.durationSeconds > 0) facts.durationSeconds = summary.durationSeconds;
    if (summary.discontinuities.length) facts.discontinuities = summary.discontinuities;
    if (summary.timestampStatus !== "continuous") warnings.push(`Stream ${index}: ${summary.reason}`);
  }
  const format = json.format && typeof json.format === "object" ? json.format as Record<string, unknown> : undefined;
  const formatTags = format?.tags && typeof format.tags === "object" ? format.tags as Record<string, unknown> : {};
  const streamTags = rawStreams.map((stream) => stream.tags && typeof stream.tags === "object" ? stream.tags as Record<string, unknown> : {});
  const video = rawStreams.find((stream) => stream.codec_type === "video");
  const audio = rawStreams.find((stream) => stream.codec_type === "audio");
  const metadataTag = (name: string) => {
    const value = formatTags[name] ?? streamTags.map((tags) => tags[name]).find((item) => item !== undefined);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const formatName = typeof format?.format_name === "string" ? format.format_name : "";
  const preferredCodec = video?.codec_name ?? audio?.codec_name ?? formatName;
  const frameRate = video ? rateValue(parseRatio(video.avg_frame_rate) ?? parseRatio(video.r_frame_rate)) : 0;
  const sampleRate = audio ? parsePositive(audio.sample_rate) ?? 0 : 0;
  const sourceMetadata = {
    ...(metadataTag("creation_time") ? { creationTime: metadataTag("creation_time") } : {}),
    ...(metadataTag("timecode") ? { timecode: metadataTag("timecode") } : {}),
    ...(metadataTag("reel_name") ? { reel: metadataTag("reel_name") } : {}),
    ...(metadataTag("time_reference") && /^\d+$/.test(metadataTag("time_reference")!) ? { bwfTimeReferenceSamples: metadataTag("time_reference") } : {}),
  };
  const containerStartSeconds = parseFinite(format?.start_time);
  return {
    streams, warnings,
    metadata: {
      duration: parsePositive(format?.duration) ?? Math.max(0, ...streams.map((stream) => stream.durationSeconds ?? 0)),
      width: parsePositive(video?.width) ?? 0,
      height: parsePositive(video?.height) ?? 0,
      frameRate,
      codec: typeof preferredCodec === "string" ? preferredCodec : "",
      sampleRate,
      channels: audio ? parseFinite(audio.channels) ?? 0 : 0,
      fileSize: file.size,
      hasVideo: !!video,
      hasAudio: !!audio,
    },
    sourceMetadata,
    ...(containerStartSeconds !== undefined ? { containerStartSeconds } : {}),
  };
}

function rateValue(rate?: RationalRate) { return rate ? rate.numerator / rate.denominator : 0; }

export function inspectPodcastMedia(sourcePath: string, signal: AbortSignal, options: { packetScan?: boolean } = {}): Promise<NativePodcastInspection> {
  return heavyQueue.run(() => inspectUnlocked(sourcePath, signal, options.packetScan !== false), signal);
}
