import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ManagedAssetRegistry } from "../src/main/lickety/asset-registry";
import { PodcastAudioReadError } from "../src/main/lickety/audio-analysis";
import { HeavyJobQueue } from "../src/main/lickety/media-jobs";
import { audioReceiptsAreContiguous, createAudioDecodeCapture, endedBeforeOutputCap, NativeAudioAnalysis, assessAudioWindowCoverage } from "../src/main/lickety/audio-analysis";

const fixtureFfmpeg = path.resolve(__dirname, "../resources/bin", `${process.platform}-${process.arch}`, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

async function captureFixtureFfmpeg(args: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<ReturnType<typeof createAudioDecodeCapture>>((resolve, reject) => {
    const child = spawn(fixtureFfmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const abort = () => child.kill("SIGKILL"); signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else {
        const data = Buffer.concat(stdout), log = Buffer.concat(stderr).toString("utf8");
        resolve(createAudioDecodeCapture(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, log, code === 0));
      }
    });
  });
}

it("reads a two-hour source in input-bounded chunks without full decode", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lickety-audio-"));
  try {
    const sourcePath = path.join(directory, "source");
    await writeFile(sourcePath, "fixture");
    const registry = new ManagedAssetRegistry(directory);
    const asset = await registry.registerOriginal("m", sourcePath);
    const reads: Array<{ inputDurationMs: number; outputFrames: number; inputCapBeforeSource: boolean }> = [];
    const audio = new NativeAudioAnalysis(registry, new HeavyJobQueue(), async (args) => {
      const inputCapIndex = args.indexOf("-t");
      const sourceIndex = args.indexOf("-i");
      const trim = args[args.indexOf("-af") + 1];
      const outputFrames = Number(/atrim=end_sample=(\d+)/.exec(trim)?.[1]);
      reads.push({
        inputDurationMs: Number(args[inputCapIndex + 1]) * 1000,
        outputFrames,
        inputCapBeforeSource: inputCapIndex < sourceIndex,
      });
      return new Float32Array(outputFrames).buffer;
    });

    let samples = 0;
    for await (const chunk of audio.readAnalysisAudio(
      asset.identity.assetId,
      1000,
      { startMs: 0, endMs: 7_200_000 },
      new AbortController().signal,
    )) {
      samples += chunk.length;
    }

    expect(samples).toBe(7_200_000);
    expect(reads).toHaveLength(1440);
    expect(reads.every((read) => read.inputCapBeforeSource)).toBe(true);
    expect(Math.max(...reads.map((read) => read.inputDurationMs))).toBeLessThanOrEqual(10_000);
    expect(reads.reduce((total, read) => total + read.outputFrames, 0)).toBe(7_200_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("refuses unbounded native audio windows", async () => {
  const audio = new NativeAudioAnalysis(new ManagedAssetRegistry("/tmp/unused"), new HeavyJobQueue());
  await expect(audio.getNativeAudioWindow("a", 0, 0, 10_001, new AbortController().signal)).rejects.toThrow(/ten|10/);
});

describe("verified audio window coverage", () => {
  const verifiedTail = {
    naturalEof: true, decoderDrained: true, resamplerFlushed: true,
    startCovered: true, contiguousTimestamps: true, decodeErrors: false,
  };

  it("accepts a verified EOF deficit only when both trial caps pass", () => {
    expect(assessAudioWindowCoverage({ requestedSamples: 55_945, validSamples: 55_887, sampleRate: 8_000, startSample: 10, eofSample: 55_897, evidence: verifiedTail })).toMatchObject({ accepted: true, validSamples: 55_887 });
    expect(assessAudioWindowCoverage({ requestedSamples: 40_000, validSamples: 39_920, sampleRate: 8_000, startSample: 0, eofSample: 39_920, evidence: verifiedTail }).accepted).toBe(true);
  });

  it("rejects short interior windows even below both caps", () => {
    expect(assessAudioWindowCoverage({ requestedSamples: 55_945, validSamples: 55_887, sampleRate: 8_000, startSample: 10, evidence: verifiedTail }).accepted).toBe(false);
  });

  it("requires exact EOF coverage and rejects either exceeded cap", () => {
    expect(assessAudioWindowCoverage({ requestedSamples: 55_945, validSamples: 55_887, sampleRate: 8_000, startSample: 10, eofSample: 55_898, evidence: verifiedTail }).accepted).toBe(false);
    expect(assessAudioWindowCoverage({ requestedSamples: 100_000, validSamples: 99_919, sampleRate: 8_000, startSample: 0, eofSample: 99_919, evidence: verifiedTail }).accepted).toBe(false);
    expect(assessAudioWindowCoverage({ requestedSamples: 100_000, validSamples: 99_799, sampleRate: 48_000, startSample: 0, eofSample: 99_799, evidence: verifiedTail }).accepted).toBe(false);
    expect(assessAudioWindowCoverage({ requestedSamples: 39_999, validSamples: 39_919, sampleRate: 8_000, startSample: 0, eofSample: 39_919, evidence: verifiedTail }).accepted).toBe(false);
    expect(assessAudioWindowCoverage({ requestedSamples: 400_000, validSamples: 399_519, sampleRate: 48_000, startSample: 0, eofSample: 399_519, evidence: verifiedTail }).accepted).toBe(false);
  });

  it("rejects unverified drain, flush, start, timestamps, or decoder errors", () => {
    for (const key of Object.keys(verifiedTail) as Array<keyof typeof verifiedTail>) {
      const evidence = { ...verifiedTail, [key]: key === "decodeErrors" ? true : false };
      expect(assessAudioWindowCoverage({ requestedSamples: 55_945, validSamples: 55_887, sampleRate: 8_000, startSample: 10, eofSample: 55_897, evidence }).accepted).toBe(false);
    }
  });

  it("rejects an exact byte count when tagged decoder diagnostics report damage", () => {
    expect(assessAudioWindowCoverage({ requestedSamples: 800, validSamples: 800, sampleRate: 8_000, startSample: 0,
      evidence: { ...verifiedTail, decodeErrors: true } })).toMatchObject({ accepted: false, reason: "unverified-eof" });
  });

  it("parses integer PTS receipts with FFmpeg repeat+level log tags and requires natural drain markers", () => {
    const stderr = [
      "[ashowinfo@input @ 0x1] [info] n:0 pts:0 pts_time:0 fmt:s16 rate:44100 nb_samples:4096 checksum:ABC",
      "[ashowinfo@output @ 0x2] [info] n:0 pts:0 pts_time:0 fmt:flt rate:8000 nb_samples:743 checksum:DEF",
      "[in#0/wav @ 0x3] [verbose] EOF while reading input",
      "[aist#0:0 @ 0x4] [verbose] Decoder returned EOF, finishing",
      "[af#0:0 @ 0x5] [verbose] Filtergraph returned EOF, finishing",
    ].join("\n");
    const capture = createAudioDecodeCapture(new ArrayBuffer(743 * 4), stderr, true);
    expect(capture.receipts.input[0]).toMatchObject({ pts: 0, sampleRate: 44_100, samples: 4096 });
    expect(capture.receipts.output[0]).toMatchObject({ pts: 0, sampleRate: 8_000, samples: 743 });
    expect(capture.naturalEof).toBe(true);
    expect(capture.decoderDrained).toBe(true);
    expect(capture.filtergraphDrained).toBe(true);
    expect(createAudioDecodeCapture(new ArrayBuffer(1), stderr, false).naturalEof).toBe(false);
    expect(createAudioDecodeCapture(new ArrayBuffer(1), "[verbose] Decoder returned EOF, finishing\n[verbose] Filtergraph returned EOF, finishing", true).naturalEof).toBe(false);
  });

  it("detects tagged decode and corruption diagnostics even when the process exits successfully", () => {
    const invalid = createAudioDecodeCapture(new ArrayBuffer(0), "[aac @ 0x1] [error] Error submitting packet to decoder", true);
    expect(invalid.decodeErrors).toBe(true);
    expect(assessAudioWindowCoverage({ requestedSamples: 10, validSamples: 10, sampleRate: 8_000, startSample: 0,
      evidence: { ...verifiedTail, decodeErrors: invalid.decodeErrors } }).accepted).toBe(false);
    expect(createAudioDecodeCapture(new ArrayBuffer(0), "[aac @ 0x1] [warning] Packet corrupt", true).decodeErrors).toBe(true);
  });

  it("checks PTS against cumulative samples so repeated small gaps do not pass", () => {
    expect(audioReceiptsAreContiguous([
      { n: 0, pts: 0, sampleRate: 8_000, samples: 800 },
      { n: 1, pts: 808, sampleRate: 8_000, samples: 800 },
      { n: 2, pts: 1_616, sampleRate: 8_000, samples: 800 },
    ], 8_000, 8)).toBe(false);
    expect(audioReceiptsAreContiguous([
      { n: 0, pts: 0, sampleRate: 48_000, samples: 1_024 },
      { n: 1, pts: 171, sampleRate: 48_000, samples: 1_024 },
      { n: 2, pts: 340, sampleRate: 48_000, samples: 1_024 },
    ], 8_000, 8)).toBe(true);
  });

  it("requires the actual output PTS end to precede the cap, including a delayed origin", () => {
    expect(endedBeforeOutputCap(40_000, 10_000, 50_000, 80_000)).toBe(true);
    expect(endedBeforeOutputCap(40_000, 39_999, 80_000, 80_000)).toBe(false);
    expect(endedBeforeOutputCap(40_000, -1, 79_999, 80_000)).toBe(false);
  });
});

describe("native receipt integration", () => {
  it("verifies a 44.1 kHz PCM tail with natural EOF and accepts only the bounded valid samples", async () => {
    const ffmpeg = fixtureFfmpeg;
    if (!existsSync(ffmpeg)) return;
    const directory = await mkdtemp(path.join(os.tmpdir(), "lickety-native-receipts-"));
    const source = path.join(directory, "tone-44100.wav");
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=20", "-ac", "1", "-y", source], { stdio: ["ignore", "ignore", "pipe"] });
        const chunks: Buffer[] = []; child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(Buffer.concat(chunks).toString("utf8"))));
      });
      const registry = new ManagedAssetRegistry(directory);
      const asset = await registry.registerOriginal("fixture-44100", source);
      const calls: string[][] = [];
      const audio = new NativeAudioAnalysis(registry, new HeavyJobQueue(), async (args, signal) => { calls.push(args); return captureFixtureFfmpeg(args, signal); });
      const result = await audio.getNativeAudioWindow(asset.identity.assetId, 0, 15_005, 5_000, new AbortController().signal, 8_000, 1, 0, {
        assetId: asset.identity.assetId, streamIndex: 0, channelIndex: 0, startSample: 120_040, streamStartSample: 0,
        eofSample: 160_000, timestampsContinuous: true, allowTail: true,
      });
      expect(result.channels[0]).toHaveLength(39_960);
      expect(result.validSamples).toBe(39_960);
      expect(result.evidence).toMatchObject({ naturalEof: true, decoderDrained: true, resamplerFlushed: true, startCovered: true, contiguousTimestamps: true, decodeErrors: false });
      expect(result.windowReceipts).toHaveLength(1);
      expect(result.windowReceipts?.[0]).toMatchObject({ startSample: 120_040, requestedSamples: 40_000, validSamples: 39_960 });
      expect(calls).toHaveLength(2);
      expect(calls[1]?.[calls[1]!.indexOf("-ss") + 1]).toBe("12.755");
      expect(calls[1]!.indexOf("-t")).toBeGreaterThan(calls[1]!.indexOf("-i"));
      expect(calls[1]!.indexOf("-copyts")).toBe(-1);
      await expect(audio.getNativeAudioWindow(asset.identity.assetId, 0, 12_505, 10_000, new AbortController().signal, 8_000, 1, 0, {
        assetId: asset.identity.assetId, streamIndex: 0, channelIndex: 0, startSample: 100_040, streamStartSample: 0,
        eofSample: 160_000, timestampsContinuous: true, allowTail: true,
      })).rejects.toMatchObject({ decodeFailure: { reason: "interior-short-read" } } satisfies Partial<PodcastAudioReadError>);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);

  it("reads a late exact 48 kHz shifted AAC window with integer timestamp receipts", async () => {
    const ffmpeg = fixtureFfmpeg;
    if (!existsSync(ffmpeg)) return;
    const fixture = path.resolve(__dirname, "../src/main/lickety/podcast/fixtures/shifted-aac-priming.mka");
    if (!existsSync(fixture)) return;
    const directory = await mkdtemp(path.join(os.tmpdir(), "lickety-native-aac-receipts-"));
    try {
      const registry = new ManagedAssetRegistry(directory);
      const asset = await registry.registerOriginal("fixture-48000", fixture);
      const calls: string[][] = [];
      const audio = new NativeAudioAnalysis(registry, new HeavyJobQueue(), async (args, signal) => { calls.push(args); return captureFixtureFfmpeg(args, signal); });
      const result = await audio.getNativeAudioWindow(asset.identity.assetId, 0, 3_000, 500, new AbortController().signal, 8_000, 1, 0, {
        assetId: asset.identity.assetId, streamIndex: 0, channelIndex: 0, startSample: 24_000, streamStartSample: 12_000,
        eofSample: 52_000, timestampsContinuous: true, timestampToleranceSamples: 8, allowTail: true,
      });
      expect(result.channels[0]).toHaveLength(4_000);
      expect(calls).toHaveLength(1);
      expect(result.windowReceipts).toHaveLength(1);
      expect(result.windowReceipts?.[0]).toMatchObject({ startSample: 24_000, requestedSamples: 4_000, validSamples: 4_000 });
      expect(result.windowReceipts?.[0].evidence.decodeErrors).toBe(false);
      expect(calls[0]?.[calls[0]!.indexOf("-ss") + 1]).toBe("1");
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);
});
