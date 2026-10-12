import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { heavyQueue } from "./media-jobs";
import { HeaderInspectionQueue, inspectOriginal } from "./import-inspection";

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
});
