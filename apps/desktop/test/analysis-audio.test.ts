import { expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ManagedAssetRegistry } from "../src/main/lickety/asset-registry";
import { HeavyJobQueue } from "../src/main/lickety/media-jobs";
import { NativeAudioAnalysis } from "../src/main/lickety/audio-analysis";

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
