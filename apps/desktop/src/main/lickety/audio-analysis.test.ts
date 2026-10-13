import { describe, expect, it, vi } from "vitest";
import { NativeAudioAnalysis } from "./audio-analysis";

describe("NativeAudioAnalysis source channel selection", () => {
  it("extracts a requested original channel before making mono PCM", async () => {
    const capture = vi.fn(async (_args: string[], _signal: AbortSignal) => new Float32Array([-0.25, 0.75]).buffer);
    const registry = { resolve: vi.fn(async () => ({ path: "/managed/original.mov", mime: "video/quicktime" })) };
    const queue = { run: <T>(work: () => Promise<T>) => work() };
    const audio = new NativeAudioAnalysis(registry as never, queue as never, capture);

    const result = await audio.getNativeAudioWindow("registered-id", 0, 0, 0.25, new AbortController().signal, 8000, 2, 1);

    expect(result.channels).toHaveLength(1);
    expect(Array.from(result.channels[0])).toEqual([-0.25, 0.75]);
    const args = capture.mock.calls[0][0];
    expect(args.slice(args.indexOf("-af"), args.indexOf("-af") + 2)).toEqual(["-af", "pan=mono|c0=c1,atrim=start=0:duration=0.00025,asetpts=PTS-0/TB,aresample=8000:first_pts=0,atrim=end_sample=2,asetpts=N/SR/TB"]);
    expect(args.slice(args.indexOf("-ac"), args.indexOf("-ac") + 2)).toEqual(["-ac", "1"]);
  });

  it("keeps two-second preroll inside the ten-second decoded-window bound", async () => {
    const capture = vi.fn(async (args: string[]) => {
      const filter = args[args.indexOf("-af") + 1];
      const duration = Number(/duration=([\d.]+)/.exec(filter)?.[1]);
      return new Float32Array(Math.round(duration * 8000)).buffer;
    });
    const registry = { resolve: vi.fn(async () => ({ path: "/managed/original.mov", mime: "video/quicktime" })) };
    const queue = { run: <T>(work: () => Promise<T>) => work() };
    const audio = new NativeAudioAnalysis(registry as never, queue as never, capture as never);
    const result = await audio.getNativeAudioWindow("registered-id", 0, 20_000, 10_000, new AbortController().signal, 8000, 1, 0);
    expect(result.channels[0]).toHaveLength(80_000);
    expect(capture).toHaveBeenCalledTimes(2);
    for (const [args] of capture.mock.calls) {
      expect(args.indexOf("-t")).toBeLessThan(args.indexOf("-i"));
      expect(Number(args[args.indexOf("-t") + 1])).toBeLessThanOrEqual(10);
    }
  });

  it("rejects channel windows that exceed the bounded duration", async () => {
    const audio = new NativeAudioAnalysis({} as never, { run: <T>(work: () => Promise<T>) => work() } as never);
    await expect(audio.getNativeAudioWindow("id", 0, 0, 10001, new AbortController().signal, 8000, 1, 0)).rejects.toThrow(/ten seconds/i);
  });
});
