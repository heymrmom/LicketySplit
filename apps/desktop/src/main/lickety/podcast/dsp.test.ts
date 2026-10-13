import { describe, expect, it } from "vitest";
import { coarseCandidates, coarseCandidatesYielding, fineCorrelation, fingerprintBlock, fitClock, peaksToHashes } from "./dsp";

const random = (n: number, seed = 5) => {
  let state = seed;
  return Float32Array.from({ length: n }, () => { state = (Math.imul(state, 1664525) + 1013904223) | 0; return state / 2147483648; });
};

describe("ported legacy podcast DSP", () => {
  it("retains legacy hash packing and coarse offset anchors", () => {
    expect(peaksToHashes([[0, 50], [1, 51], [2, 49], [3, 52], [4, 54], [65, 52]])).toEqual([
      [0, 208834], [0, 204931], [0, 205060], [1, 208962], [1, 209091], [2, 201026], [3, 213054], [4, 225213],
    ]);
    expect(coarseCandidates([[100, 1], [102, 2], [104, 3], [106, 4], [108, 5], [110, 6]], [[200, 1], [202, 2], [204, 3], [206, 4], [208, 5], [210, 6]])[0].offsetSeconds).toBe(-3.2);
  });

  it("locates signed offsets and rejects silence without downmixing channels", () => {
    const pcm = random(24000);
    for (const offset of [0, 1, 701, 12345]) expect(fineCorrelation(pcm, pcm.slice(offset, offset + 6000)).lagSamples).toBe(offset);
    const antiPhase = pcm.slice(500, 8500).map((sample) => -sample * 0.2);
    const match = fineCorrelation(pcm, antiPhase);
    expect(match.lagSamples).toBe(500);
    expect(match.polarity).toBe(-1);
    expect(fineCorrelation(new Float32Array(20000), new Float32Array(8000)).score).toBe(0);
  });

  it("keeps legacy fingerprint anchors and distributed drift behavior", () => {
    expect(fingerprintBlock(new Float32Array(32000))).toEqual([]);
    expect(fingerprintBlock(random(32000)).length).toBeGreaterThan(0);
    const anchors = [0, 300, 900, 1800, 3000, 7000].map((sourceSeconds) => ({ sourceSeconds, referenceSeconds: 1.00002 * sourceSeconds - 12.34 }));
    const fit = fitClock(anchors);
    expect(fit.scale).toBeCloseTo(1.00002, 10);
    expect(fit.offsetSeconds).toBeCloseTo(-12.34, 8);
  });

  it("keeps yielding coarse votes bit-for-bit aligned with the legacy matcher and honors cancellation", async () => {
    const a = Array.from({ length: 20000 }, (_, i) => [i * 2, i % 179] as [number, number]);
    const b = a.map(([time, hash]) => [time + 400, hash] as [number, number]);
    expect(await coarseCandidatesYielding(a, b, new AbortController().signal)).toEqual(coarseCandidates(a, b));
    const controller = new AbortController(); controller.abort();
    await expect(coarseCandidatesYielding(a, b, controller.signal)).rejects.toThrow();
  });
});
