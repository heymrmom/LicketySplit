import { spawn } from "node:child_process";
import type { PodcastDecodeFailure, PodcastDecodeReceipt } from "../../../../../packages/core/src/lickety/podcast-types";
import { ManagedAssetRegistry } from "./asset-registry";
import { HeavyJobQueue } from "./media-jobs";

const SEEK_PREROLL_MS = 2_000;
const ALTERNATE_PREROLL_MS = 250;
const MAX_DECODE_WINDOW_MS = 10_000;
const MAX_AUDIO_WINDOW_MS = MAX_DECODE_WINDOW_MS - SEEK_PREROLL_MS - ALTERNATE_PREROLL_MS * 2;

export interface AudioWindowEvidence {
  naturalEof: boolean;
  decoderDrained: boolean;
  resamplerFlushed: boolean;
  startCovered: boolean;
  contiguousTimestamps: boolean;
  decodeErrors: boolean;
}

interface FrameReceipt { n: number; pts: number; sampleRate: number; samples: number }
interface DecodedReceipts { input: FrameReceipt[]; output: FrameReceipt[] }
export interface AudioDecodeCapture {
  bytes: ArrayBuffer;
  stderr: string;
  processSucceeded: boolean;
  receipts: DecodedReceipts;
  naturalEof: boolean;
  decoderDrained: boolean;
  filtergraphDrained: boolean;
  stderrTruncated: boolean;
  decodeErrors: boolean;
}
export interface AudioWindowReceipt {
  startSample: number; requestedSamples: number; validSamples: number;
  inputStartSample?: number; inputEndSample?: number; outputStartSample?: number; outputEndSample?: number;
  evidence: AudioWindowEvidence;
}

export interface AudioWindowCoverageContext {
  assetId: string;
  streamIndex: number;
  channelIndex: number;
  startSample: number;
  streamStartSample: number;
  eofSample: number;
  timestampToleranceSamples?: number;
  timestampsContinuous: boolean;
  allowTail: boolean;
}

export function assessAudioWindowCoverage(args: {
  requestedSamples: number;
  validSamples: number;
  sampleRate: number;
  startSample: number;
  eofSample?: number;
  evidence: AudioWindowEvidence;
}): { accepted: boolean; validSamples: number; reason?: PodcastDecodeFailure["reason"] } {
  const { requestedSamples, validSamples, sampleRate, startSample, eofSample, evidence } = args;
  if (!Number.isSafeInteger(requestedSamples) || requestedSamples < 0 || !Number.isSafeInteger(validSamples) || validSamples < 0 || validSamples > requestedSamples || !Number.isSafeInteger(sampleRate) || sampleRate < 1 || !Number.isSafeInteger(startSample) || startSample < 0) {
    return { accepted: false, validSamples: Math.max(0, validSamples), reason: "unverified-eof" };
  }
  if (validSamples === requestedSamples) {
    return evidence.startCovered && evidence.contiguousTimestamps && !evidence.decodeErrors
      ? { accepted: true, validSamples }
      : { accepted: false, validSamples, reason: "unverified-eof" };
  }
  if (validSamples > requestedSamples || requestedSamples === 0 || validSamples === 0 || eofSample === undefined) {
    return { accepted: false, validSamples, reason: "unverified-eof" };
  }
  const expectedSamples = Math.min(requestedSamples, Math.max(0, eofSample - startSample));
  if (validSamples !== expectedSamples) return { accepted: false, validSamples, reason: "unverified-eof" };
  if (!evidence.naturalEof || !evidence.decoderDrained || !evidence.resamplerFlushed || !evidence.startCovered || !evidence.contiguousTimestamps || evidence.decodeErrors) {
    return { accepted: false, validSamples, reason: "unverified-eof" };
  }
  const deficit = requestedSamples - validSamples;
  if (deficit * 100 > sampleRate || deficit * 1_000 > requestedSamples * 2) return { accepted: false, validSamples, reason: "eof-over-cap" };
  return { accepted: true, validSamples };
}

type Capture = (args: string[], signal: AbortSignal) => Promise<ArrayBuffer | AudioDecodeCapture>;

function parseReceipts(stderr: string): DecodedReceipts {
  const input: FrameReceipt[] = [], output: FrameReceipt[] = [];
  const line = /\[(ashowinfo@input|ashowinfo@output) @ [^\]]+\] (?:\[(?:info)\] )?n:(\d+) pts:(-?\d+) pts_time:[^ ]+ .*? rate:(\d+) nb_samples:(\d+)/;
  for (const row of stderr.split("\n")) {
    const match = line.exec(row);
    if (!match) continue;
    const receipt = { n: Number(match[2]), pts: Number(match[3]), sampleRate: Number(match[4]), samples: Number(match[5]) };
    (match[1] === "ashowinfo@input" ? input : output).push(receipt);
  }
  return { input, output };
}

export function audioReceiptsAreContiguous(receipts: Array<{ n: number; pts: number; sampleRate: number; samples: number }>, targetRate: number, toleranceSamples = 1): boolean {
  if (!receipts.length || receipts.some((row) => !Number.isSafeInteger(row.n) || !Number.isSafeInteger(row.pts) || !Number.isSafeInteger(row.sampleRate) || row.sampleRate < 1 || !Number.isSafeInteger(row.samples) || row.samples < 1)) return false;
  const first = receipts[0];
  let sourceSamples = first.samples;
  for (let i = 1; i < receipts.length; i++) {
    const current = receipts[i];
    const expectedPts = first.pts + Math.floor((sourceSamples * targetRate) / first.sampleRate + 0.5);
    if (current.n !== receipts[i - 1].n + 1 || Math.abs(current.pts - expectedPts) > toleranceSamples) return false;
    sourceSamples += current.samples;
  }
  return true;
}

export function endedBeforeOutputCap(validSamples: number, outputStartSample: number | undefined, outputEndSample: number | undefined, capSamples: number): boolean {
  return Number.isSafeInteger(validSamples) && validSamples >= 0 && validSamples < capSamples
    && outputStartSample !== undefined && outputEndSample !== undefined
    && Number.isSafeInteger(outputStartSample) && Number.isSafeInteger(outputEndSample)
    && outputEndSample < capSamples && outputEndSample - outputStartSample < capSamples;
}

function receiptSampleRange(receipts: FrameReceipt[], sampleRate: number) {
  const first = receipts[0], last = receipts.at(-1);
  if (!first || !last || receipts.some((row) => row.sampleRate !== first.sampleRate)) return undefined;
  return {
    start: first.pts,
    end: last.pts + sampleAt(last.samples * 1_000 / last.sampleRate, sampleRate),
    samples: Math.floor((receipts.reduce((sum, row) => sum + row.samples, 0) * sampleRate) / first.sampleRate + 0.5),
  };
}

function hasDecodeErrors(stderr: string, truncated: boolean): boolean {
  if (truncated) return true;
  return stderr.split("\n").some((line) => {
    if (/\[(?:error|fatal)\]/i.test(line)) return true;
    if (/\[warning\]/i.test(line)) return /(?:corrupt|invalid data|error decoding|input\/output error|failed to decode|damaged frame)/i.test(line);
    if (/\[(?:debug|verbose|info)\]/i.test(line)) return false;
    return /\b(?:error while|error opening|invalid data found|corrupt input|decode error:|input\/output error|error submitting packet to decoder)\b/i.test(line);
  });
}

export function createAudioDecodeCapture(bytes: ArrayBuffer, stderr: string, processSucceeded: boolean, stderrTruncated = false): AudioDecodeCapture {
  return {
    bytes, stderr, processSucceeded, receipts: parseReceipts(stderr),
    naturalEof: processSucceeded && /(?:^|\s)\[(?:debug|verbose)\] EOF while reading input\.?$/m.test(stderr),
    decoderDrained: processSucceeded && /(?:^|\s)\[(?:debug|verbose)\] Decoder returned EOF, finishing\.?$/m.test(stderr),
    filtergraphDrained: processSucceeded && /(?:^|\s)\[(?:debug|verbose)\] Filtergraph returned EOF, finishing\.?$/m.test(stderr),
    stderrTruncated,
    decodeErrors: hasDecodeErrors(stderr, stderrTruncated),
  };
}

async function capturePcm(args: string[], signal: AbortSignal): Promise<AudioDecodeCapture> {
  const { resolveFfmpegPath } = await import("../sidecar/ffmpeg-path");
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let length = 0, errorLength = 0, timedOut = false;
    const abort = () => child.kill("SIGKILL");
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30_000);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 16 * 1024 ** 2) { child.kill("SIGKILL"); reject(new Error("Audio range exceeded bounded output")); }
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorLength += chunk.length;
      if (errorLength <= 1024 * 1024) errors.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else if (timedOut) reject(new Error("Bounded audio decode exceeded 30 seconds."));
      else {
        const bytes = Buffer.concat(chunks);
        const stderr = Buffer.concat(errors).toString("utf8");
        resolve(createAudioDecodeCapture(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, stderr, code === 0, errorLength > 1024 * 1024));
      }
    });
  });
}

export class PodcastAudioReadError extends Error {
  constructor(readonly decodeFailure: PodcastDecodeFailure) {
    super(`Native decoder returned ${decodeFailure.validSamples} of ${decodeFailure.requestedSamples} requested audio samples (${decodeFailure.reason}).`);
    this.name = "PodcastAudioReadError";
  }
}

function sampleAt(milliseconds: number, sampleRate: number): number {
  // Sample boundaries use nearest integer, with positive half-samples rounded upward.
  return Math.floor((milliseconds * sampleRate) / 1_000 + 0.5);
}

function unwrapCapture(value: ArrayBuffer | AudioDecodeCapture): AudioDecodeCapture {
  return value instanceof ArrayBuffer ? createAudioDecodeCapture(value, "", true) : value;
}

export class NativeAudioAnalysis {
  constructor(private registry: ManagedAssetRegistry, private queue: HeavyJobQueue, private capture: Capture = capturePcm) {}

  async getNativeAudioWindow(
    assetId: string,
    trackIndex: number,
    startMs: number,
    durationMs: number,
    signal: AbortSignal,
    sampleRate = 48_000,
    channels = 2,
    sourceChannelIndex?: number,
    coverage?: AudioWindowCoverageContext,
  ): Promise<{ channels: Float32Array[]; sampleRate: number; validSamples?: number; evidence?: AudioWindowEvidence; windowReceipts?: PodcastDecodeReceipt[] }> {
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 10_000) throw new Error("Audio window must be at most ten seconds (10000 ms)");
    if (startMs < 0 || !Number.isFinite(startMs) || !Number.isInteger(trackIndex) || trackIndex < 0 || !Number.isInteger(sampleRate) || sampleRate < 1 || !Number.isInteger(channels) || channels < 1 || channels > 2 || (sourceChannelIndex !== undefined && (!Number.isInteger(sourceChannelIndex) || sourceChannelIndex < 0 || sourceChannelIndex > 63))) throw new Error("Invalid original audio range");
    return this.queue.run(async () => {
      const source = await this.registry.resolve(assetId, "original");
      const outputChannels = sourceChannelIndex === undefined ? channels : 1;
      const totalFrames = sampleAt(durationMs, sampleRate);
      const output = Array.from({ length: outputChannels }, () => new Float32Array(totalFrames));
      let written = 0, validTotal = 0, acceptedTail = false;
      const windowReceipts: PodcastDecodeReceipt[] = [];
      let acceptedEvidence: AudioWindowEvidence | undefined;
      while (written < totalFrames) {
        signal.throwIfAborted();
        const frames = Math.min(Math.floor(sampleRate * MAX_AUDIO_WINDOW_MS / 1_000), totalFrames - written);
        const chunkStartMs = startMs + (written * 1_000) / sampleRate;
        const chunkDurationMs = (frames * 1_000) / sampleRate;
        const requestedStartSample = coverage ? coverage.startSample + written : sampleAt(chunkStartMs, sampleRate);
        const allowTail = Boolean(coverage?.allowTail && written + frames === totalFrames);
        const buildArgs = (extraPrerollMs: number, tail = false) => {
          const inputSeekMs = Math.max(0, chunkStartMs - SEEK_PREROLL_MS - extraPrerollMs);
          const args = ["-hide_banner", "-loglevel", coverage ? "repeat+level+debug" : "error", ...(tail ? [] : ["-copyts", "-start_at_zero"]), "-ss", String(inputSeekMs / 1_000)];
          if (!tail) args.push("-t", String((chunkStartMs + chunkDurationMs - inputSeekMs) / 1_000));
          args.push("-i", source.path);
          if (tail) args.push("-t", String(MAX_DECODE_WINDOW_MS / 1_000));
          args.push("-map", `0:a:${trackIndex}`, "-vn");
          const filters: string[] = [];
          if (sourceChannelIndex !== undefined) filters.push(`pan=mono|c0=c${sourceChannelIndex}`);
          if (tail) filters.push(`asettb=expr=1/${sampleRate}`, "ashowinfo@input", `aresample=${sampleRate}`, `asettb=expr=1/${sampleRate}`, "ashowinfo@output");
          else if (coverage) filters.push(`asettb=expr=1/${sampleRate}`, "ashowinfo@input", `atrim=start=${chunkStartMs / 1_000}:duration=${chunkDurationMs / 1_000}`, `asetpts=PTS-${chunkStartMs / 1_000}/TB`, `aresample=${sampleRate}`, `asettb=expr=1/${sampleRate}`, "ashowinfo@output", `atrim=end_sample=${frames}`, "asetpts=N/SR/TB");
          else filters.push(`atrim=start=${chunkStartMs / 1_000}:duration=${chunkDurationMs / 1_000}`, `asetpts=PTS-${chunkStartMs / 1_000}/TB`, `aresample=${sampleRate}:first_pts=0`, `atrim=end_sample=${frames}`, "asetpts=N/SR/TB");
          args.push("-af", filters.join(","), "-ar", String(sampleRate), "-ac", String(outputChannels), "-f", "f32le", "pipe:1");
          return { args, inputSeekMs };
        };
        let interleaved: Float32Array;
        let count: number;
        let evidence: AudioWindowEvidence;
        let assessment: ReturnType<typeof assessAudioWindowCoverage>;
        let inputRange: ReturnType<typeof receiptSampleRange> | undefined, outputRange: ReturnType<typeof receiptSampleRange> | undefined;
        if (!coverage) {
          const capture = unwrapCapture(await this.capture(buildArgs(0).args, signal));
          interleaved = new Float32Array(capture.bytes);
          count = interleaved.length / outputChannels;
          evidence = { naturalEof: false, decoderDrained: false, resamplerFlushed: false, startCovered: true, contiguousTimestamps: true, decodeErrors: hasDecodeErrors(capture.stderr, capture.stderrTruncated) };
          assessment = assessAudioWindowCoverage({ requestedSamples: frames, validSamples: count, sampleRate, startSample: requestedStartSample, evidence });
        } else {
          const firstCommand = buildArgs(0);
          const first = unwrapCapture(await this.capture(firstCommand.args, signal));
          const firstBytes = new Float32Array(first.bytes);
          const firstCount = firstBytes.length / outputChannels;
          const firstInputRange = receiptSampleRange(first.receipts.input, sampleRate), firstOutputRange = receiptSampleRange(first.receipts.output, sampleRate);
          inputRange = firstInputRange; outputRange = firstOutputRange;
          const firstEvidence: AudioWindowEvidence = {
            naturalEof: false, decoderDrained: false, resamplerFlushed: false,
            startCovered: !!firstInputRange && firstInputRange.start <= requestedStartSample
              && firstInputRange.end >= requestedStartSample + frames
              && !!firstOutputRange && firstOutputRange.start === 0,
            contiguousTimestamps: audioReceiptsAreContiguous(first.receipts.input, sampleRate, coverage.timestampToleranceSamples ?? 1) && audioReceiptsAreContiguous(first.receipts.output, sampleRate),
            decodeErrors: first.decodeErrors,
          };
          if (first.processSucceeded && Number.isSafeInteger(firstCount) && firstCount === frames && firstOutputRange?.samples === firstCount && firstEvidence.startCovered && firstEvidence.contiguousTimestamps && !firstEvidence.decodeErrors) {
            interleaved = firstBytes; count = firstCount; evidence = firstEvidence;
            assessment = { accepted: true, validSamples: count };
          } else {
            const alternate = buildArgs(ALTERNATE_PREROLL_MS, true);
            const retry = unwrapCapture(await this.capture(alternate.args, signal));
            const retryBytes = new Float32Array(retry.bytes), retryCount = retryBytes.length / outputChannels;
            const retryInputRange = receiptSampleRange(retry.receipts.input, sampleRate), retryOutputRange = receiptSampleRange(retry.receipts.output, sampleRate);
            inputRange = retryInputRange; outputRange = retryOutputRange;
            const relativeStartSample = sampleAt(chunkStartMs - alternate.inputSeekMs, sampleRate);
            const startOffset = retryOutputRange ? relativeStartSample - retryOutputRange.start : -1;
            const validFromStart = Number.isSafeInteger(retryCount) && Number.isSafeInteger(startOffset) && startOffset >= 0 && retryCount > startOffset ? Math.min(frames, retryCount - startOffset) : 0;
            const outputFrameCap = MAX_DECODE_WINDOW_MS * sampleRate / 1_000;
            const outputStart = retryOutputRange?.start, outputEnd = retryOutputRange?.end;
            const naturalEof = retry.processSucceeded && retry.naturalEof && retry.decoderDrained
              && endedBeforeOutputCap(retryCount, outputStart, outputEnd, outputFrameCap);
            const rawStart = retryInputRange?.start;
            const rawEnd = retryInputRange?.end;
            evidence = {
              naturalEof,
              decoderDrained: naturalEof,
              resamplerFlushed: retry.filtergraphDrained && retryOutputRange?.samples === retryCount,
              startCovered: !!retryInputRange && !!retryOutputRange && rawStart !== undefined && rawEnd !== undefined && outputStart !== undefined && outputEnd !== undefined
                && rawStart <= relativeStartSample && rawEnd >= relativeStartSample + validFromStart
                && outputStart <= relativeStartSample && outputEnd >= relativeStartSample + validFromStart && retryCount >= startOffset + validFromStart,
              contiguousTimestamps: audioReceiptsAreContiguous(retry.receipts.input, sampleRate, coverage.timestampToleranceSamples ?? 1) && audioReceiptsAreContiguous(retry.receipts.output, sampleRate),
              decodeErrors: retry.decodeErrors,
            };
            interleaved = retryBytes.slice(startOffset * outputChannels, (startOffset + validFromStart) * outputChannels);
            count = validFromStart;
            const eofSample = requestedStartSample + validFromStart;
            const exactRetry = retry.processSucceeded && Number.isSafeInteger(count) && count === frames && evidence.startCovered && evidence.contiguousTimestamps && !evidence.decodeErrors;
            assessment = exactRetry ? { accepted: true, validSamples: count }
              : allowTail ? assessAudioWindowCoverage({ requestedSamples: frames, validSamples: count, sampleRate, startSample: requestedStartSample, eofSample, evidence })
                : { accepted: false, validSamples: count, reason: "interior-short-read" };
          }
        }
        if (!Number.isInteger(count) || !assessment.accepted) {
          const failureEvidence = evidence;
          throw new PodcastAudioReadError({
            version: 1, id: `${assetId}:${trackIndex}:${sourceChannelIndex ?? 0}:${requestedStartSample}:${frames}`,
            assetId: coverage?.assetId ?? assetId, sourceId: assetId, streamIndex: coverage?.streamIndex ?? trackIndex,
            channelIndex: coverage?.channelIndex ?? sourceChannelIndex ?? 0, startSample: requestedStartSample,
            requestedSamples: frames, validSamples: Number.isInteger(count) ? count : Math.max(0, Math.floor(count)), sampleRate,
            reason: assessment.reason ?? "unverified-eof", evidence: failureEvidence, attempts: 1,
            receipts: { startSample: requestedStartSample, requestedSamples: frames, validSamples: Number.isInteger(count) ? count : Math.max(0, Math.floor(count)), inputStartSample: inputRange?.start, inputEndSample: inputRange?.end, outputStartSample: outputRange?.start, outputEndSample: outputRange?.end, evidence: failureEvidence },
          });
        }
        const validCount = assessment.validSamples;
        acceptedEvidence = evidence;
        windowReceipts.push({ startSample: requestedStartSample, requestedSamples: frames, validSamples: validCount,
          ...(inputRange ? { inputStartSample: inputRange.start, inputEndSample: inputRange.end } : {}),
          ...(outputRange ? { outputStartSample: outputRange.start, outputEndSample: outputRange.end } : {}), evidence });
        for (let i = 0; i < validCount; i++) for (let c = 0; c < outputChannels; c++) output[c][written + i] = interleaved[i * outputChannels + c];
        validTotal += validCount;
        written += frames;
        if (validCount < frames) { acceptedTail = true; break; }
      }
      const resultChannels = acceptedTail ? output.map((channel) => channel.slice(0, validTotal)) : output;
      return { channels: resultChannels, sampleRate, ...(coverage ? { windowReceipts } : {}), ...(acceptedTail ? { validSamples: validTotal, evidence: acceptedEvidence } : {}) };
    }, signal);
  }

  async *readAnalysisAudio(assetId: string, sampleRate: 1_000 | 16_000, range: { startMs: number; endMs: number }, signal: AbortSignal): AsyncIterable<Float32Array> {
    if (range.endMs <= range.startMs) throw new Error("Invalid analysis range");
    for (let start = range.startMs; start < range.endMs; start += 10_000) {
      signal.throwIfAborted();
      const window = await this.getNativeAudioWindow(assetId, 0, start, Math.min(10_000, range.endMs - start), signal, sampleRate, 1);
      yield window.channels[0];
    }
  }
}
