import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NativeAudioAnalysis } from "../audio-analysis";
import { heavyQueue } from "../media-jobs";
import { resolveMediaInspectorPath } from "../../sidecar/media-inspector-path";
import { inspectPodcastMedia, packetOriginToleranceSeconds, VideoPacketScan } from "./native-packet-inspector";

vi.mock("electron", () => ({ app: { isPackaged: false } }));

const fixture = path.join(__dirname, "fixtures/shifted-aac-priming.mka");
const mixedFixture = path.join(__dirname, "fixtures/video-zero-audio-start-1_5s.mkv");
const ffmpeg = path.join(__dirname, "../../../../resources/bin/darwin-arm64/ffmpeg");

function capture(args: string[], signal: AbortSignal): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let length = 0;
    const abort = () => child.kill("SIGKILL"); signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { chunks.push(chunk); length += chunk.length; });
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", (code) => { signal.removeEventListener("abort", abort); if (signal.aborted) reject(signal.reason); else if (code !== 0) reject(new Error(`ffmpeg exited with ${code}`)); else { const bytes = Buffer.concat(chunks); resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer); } });
  });
}

describe("native packet timing", () => {
  it("decodes only bounded windows from a ten-minute source at a late seek", async () => {
    if (!existsSync(ffmpeg)) return;
    const directory = await mkdtemp(path.join(os.tmpdir(), "podcast-bounded-decode-"));
    const source = path.join(directory, "ten-minute.m4a");
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=991:sample_rate=48000:duration=600", "-c:a", "aac", "-b:a", "32k", "-ac", "1", "-y", source], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        child.once("error", reject);
        child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `ffmpeg exited with ${code}`)));
      });
      const calls: { args: string[]; elapsedMs: number }[] = [];
      const measuredCapture = async (args: string[], signal: AbortSignal) => {
        const started = performance.now();
        const result = await capture(args, signal);
        calls.push({ args, elapsedMs: performance.now() - started });
        return result;
      };
      const audio = new NativeAudioAnalysis({ resolve: async () => ({ path: source, mime: "audio/mp4" }) } as never, heavyQueue, measuredCapture);
      const started = performance.now();
      const result = await audio.getNativeAudioWindow("fixture", 0, 300_000, 10_000, new AbortController().signal, 8000, 1, 0);
      const wallMs = performance.now() - started;
      expect(result.channels[0]).toHaveLength(80_000);
      expect(calls).toHaveLength(2);
      expect(calls.map(({ args }) => Number(args[args.indexOf("-t") + 1]))).toEqual([9.5, 4.5]);
      expect(calls.every(({ args }) => args.indexOf("-t") < args.indexOf("-i"))).toBe(true);
      expect(wallMs).toBeLessThan(10_000);
      console.info(`Bounded late read from 600s media: ${calls.map((call) => `${call.elapsedMs.toFixed(0)}ms`).join(" + ")} FFmpeg, ${wallMs.toFixed(0)}ms total; 80,000 frames returned.`);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);

  it("reconciles shifted AAC packet PTS and skip-sample priming with the bounded reader clock", async () => {
    if (!existsSync(resolveMediaInspectorPath()) || !existsSync(ffmpeg)) return;
    const inspection = await inspectPodcastMedia(fixture, new AbortController().signal);
    const stream = inspection.streams.find((item) => item.kind === "audio");
    expect(stream).toMatchObject({ index: 0, startSeconds: 1.5, timestampStatus: "continuous", initialPadding: 1024 });
    expect(stream?.durationSeconds).toBeGreaterThan(4.9);
    expect(stream?.durationSeconds).toBeLessThan(5.1);

    const audio = new NativeAudioAnalysis({ resolve: async () => ({ path: fixture, mime: "audio/x-matroska" }) } as never, heavyQueue, capture);
    const signal = new AbortController().signal;
    const bounded = await audio.getNativeAudioWindow("fixture", 0, 0, 1000, signal, 8000, 1, 0);
    const fullStart = new Float32Array(await capture(["-hide_banner", "-loglevel", "error", "-copyts", "-start_at_zero", "-i", fixture, "-map", "0:a:0", "-vn", "-af", "atrim=start=0:duration=1,asetpts=PTS-0/TB,aresample=8000:first_pts=0,atrim=end_sample=8000,asetpts=N/SR/TB", "-ar", "8000", "-ac", "1", "-f", "f32le", "pipe:1"], signal));
    expect(fullStart.length).toBeGreaterThanOrEqual(8000);
    expect(Array.from(bounded.channels[0].slice(0, 8000))).toEqual(Array.from(fullStart.slice(0, 8000)));
  });

  it("keeps setup inspection metadata-only and marks packet timing unverified", async () => {
    if (!existsSync(resolveMediaInspectorPath())) return;
    const inspection = await inspectPodcastMedia(fixture, new AbortController().signal, { packetScan: false });
    expect(inspection.metadata).toMatchObject({ hasAudio: true, hasVideo: false, sampleRate: expect.any(Number), fileSize: expect.any(Number) });
    expect(inspection.streams[0].timestampStatus).toBe("not-scanned");
  });

  it("seeks mixed video/audio sources in container presentation time for later windows", async () => {
    if (!existsSync(resolveMediaInspectorPath()) || !existsSync(ffmpeg)) return;
    const inspection = await inspectPodcastMedia(mixedFixture, new AbortController().signal);
    const video = inspection.streams.find((item) => item.kind === "video");
    const stream = inspection.streams.find((item) => item.kind === "audio");
    expect(inspection.containerStartSeconds).toBe(0);
    expect(video).toMatchObject({ startSeconds: 0, timestampStatus: "continuous" });
    expect(stream).toMatchObject({ startSeconds: 1.5, timestampStatus: "continuous" });

    const audio = new NativeAudioAnalysis({ resolve: async () => ({ path: mixedFixture, mime: "video/x-matroska" }) } as never, heavyQueue, capture);
    const signal = new AbortController().signal;
    for (const startMs of [2000, 3000]) {
      const bounded = await audio.getNativeAudioWindow("fixture", 0, startMs, 500, signal, 8000, 1, 0);
      const full = new Float32Array(await capture(["-hide_banner", "-loglevel", "error", "-copyts", "-start_at_zero", "-i", mixedFixture, "-map", "0:a:0", "-vn", "-af", `pan=mono|c0=c0,atrim=start=${startMs / 1000}:duration=0.5,asetpts=PTS-${startMs / 1000}/TB,aresample=8000:first_pts=0,atrim=end_sample=4000,asetpts=N/SR/TB`, "-ar", "8000", "-ac", "1", "-f", "f32le", "pipe:1"], signal));
      expect(bounded.channels[0]).toHaveLength(4000);
      expect(full).toHaveLength(4000);
      let maximumDifference = 0;
      for (let index = 0; index < bounded.channels[0].length; index++) maximumDifference = Math.max(maximumDifference, Math.abs(bounded.channels[0][index] - full[index]));
      expect(maximumDifference).toBeLessThan(0.005);
    }
  });

  it("returns bounded known silence before a verified delayed audio stream starts", async () => {
    if (!existsSync(resolveMediaInspectorPath()) || !existsSync(ffmpeg)) return;
    const audio = new NativeAudioAnalysis({ resolve: async () => ({ path: mixedFixture, mime: "video/x-matroska" }) } as never, heavyQueue, capture);
    const window = await audio.getNativeAudioWindow("fixture", 0, 0, 2000, new AbortController().signal, 8000, 1, 0);
    expect(window.channels[0]).toHaveLength(16_000);
    expect(window.channels[0].slice(0, 11_500).every((sample) => sample === 0)).toBe(true);
    expect(window.channels[0].slice(12_000).some((sample) => Math.abs(sample) > 0.001)).toBe(true);
  });

  it("normalizes standalone positive container origins before later file-relative seeks", async () => {
    if (!existsSync(resolveMediaInspectorPath()) || !existsSync(ffmpeg)) return;
    const audio = new NativeAudioAnalysis({ resolve: async () => ({ path: fixture, mime: "audio/x-matroska" }) } as never, heavyQueue, capture);
    const signal = new AbortController().signal;
    const startMs = 2000;
    const bounded = await audio.getNativeAudioWindow("fixture", 0, startMs, 500, signal, 8000, 1, 0);
    const reference = new Float32Array(await capture(["-hide_banner", "-loglevel", "error", "-copyts", "-start_at_zero", "-i", fixture, "-map", "0:a:0", "-vn", "-af", `pan=mono|c0=c0,atrim=start=${startMs / 1000}:duration=0.5,asetpts=PTS-${startMs / 1000}/TB,aresample=8000:first_pts=0,atrim=end_sample=4000,asetpts=N/SR/TB`, "-ar", "8000", "-ac", "1", "-f", "f32le", "pipe:1"], signal));
    expect(bounded.channels[0]).toHaveLength(4000);
    expect(reference).toHaveLength(4000);
    let maximumDifference = 0;
    for (let index = 0; index < reference.length; index++) maximumDifference = Math.max(maximumDifference, Math.abs(bounded.channels[0][index] - reference[index]));
    expect(maximumDifference).toBeLessThan(0.005);
  });

  it("retains the legacy packet-only cadence and discard policy", () => {
    const scan = new VideoPacketScan(1 / 30, 10);
    scan.add(-1 / 30, 1 / 30, "KD");
    for (let i = 0; i < 300; i++) scan.add(i / 30, 1 / 30, "K_");
    expect(scan.finish()).toMatchObject({ timestampStatus: "continuous", count: 300, discardedPackets: 1 });
  });

  it("interprets time_base as seconds per tick when reconciling packet and stream origins", () => {
    const millisecondTicks = packetOriginToleranceSeconds({ numerator: 1, denominator: 1000 }, 48000);
    const sampleTicks = packetOriginToleranceSeconds({ numerator: 1, denominator: 48000 }, 48000);
    expect(millisecondTicks).toBe(0.002);
    expect(sampleTicks).toBeCloseTo(2 / 48000, 12);
    expect(0.003).toBeGreaterThan(millisecondTicks);
  });
});
