import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { heavyQueue } from "./media-jobs";
import { HeaderInspectionQueue, inspectOriginal, parseOriginalMetadata } from "./import-inspection";

const ffmpegHeader = "Duration: 00:00:01.00, start: 0.000000\n Stream #0:0: Video: h264, yuv420p, 1920x1080, 30 fps";

describe("original metadata inspection scheduling", () => {
  it("finishes a header inspection while a heavy media job is held", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "lickety-import-inspection-"));
    try {
      const source = path.join(directory, "source.mov");
      await writeFile(source, "source fixture");
      let releaseHeavy!: () => void;
      let heavyStarted!: () => void;
      const started = new Promise<void>((resolve) => { heavyStarted = resolve; });
      const blocker = heavyQueue.run(async () => {
        heavyStarted();
        await new Promise<void>((resolve) => { releaseHeavy = resolve; });
      }, new AbortController().signal);
      await started;

      const info = await inspectOriginal(source, async () => ffmpegHeader);
      expect(info.hasVideo).toBe(true);
      expect(info.width).toBe(1920);
      releaseHeavy();
      await blocker;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs at most one header probe and rejects excess queued inspections", async () => {
    const queue = new HeaderInspectionQueue(1);
    let release!: () => void;
    let entered!: () => void;
    let calls=0;
    let activeCount=0;
    let maxActive=0;
    const active = new Promise<void>((resolve) => { entered = resolve; });
    const run = () => queue.run(async () => {
      calls++;
      activeCount++;maxActive=Math.max(maxActive,activeCount);
      if(calls===1){entered();await new Promise<void>((resolve) => { release = resolve; });}
      activeCount--;
      return { duration: 1 } as never;
    });
    const first = run();
    await active;
    const second = run();
    await expect(run()).rejects.toThrow("Original inspection queue is full");
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
  });

  it("preserves the inspected WAV container for a supported mono PCM source", () => {
    const metadata = parseOriginalMetadata("Input #0, wav, from 'mic.wav':\nDuration: 00:00:10.00, start: 0.000000, bitrate: 706 kb/s\nStream #0:0: Audio: pcm_s16le, 44100 Hz, mono, s16, 705 kb/s", 1000);
    expect(metadata).toMatchObject({ mimeType: "audio/wav", container: "wav", codec: "pcm_s16le", channels: 1, audioTrackCount: 1 });
  });

  it("does not label an AIFF file as WAV based on its PCM codec", () => {
    const metadata = parseOriginalMetadata("Input #0, aiff, from 'mic.aiff':\nDuration: 00:00:10.00, start: 0.000000, bitrate: 706 kb/s\nStream #0:0: Audio: pcm_s16le, 44100 Hz, mono, s16, 705 kb/s", 1000);
    expect(metadata).toMatchObject({ mimeType: "audio/aiff", container: "aiff", codec: "pcm_s16le", channels: 1, audioTrackCount: 1 });
  });
});
