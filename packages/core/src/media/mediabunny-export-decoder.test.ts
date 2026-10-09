import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportFrameDecoder, MediaBunnyEngine } from "./mediabunny-engine";
import { videoDecoderBudget, type VideoDecoderLease } from "../video/video-decoder-budget";

const mediaMocks = vi.hoisted(() => ({
  disposed: vi.fn(),
  inputs: vi.fn(),
  trackGate: null as Promise<void> | null,
  trackStarted: null as (() => void) | null,
  canvasGate: null as Promise<void> | null,
  canvasStarted: null as (() => void) | null,
}));

vi.mock("mediabunny", () => {
  class MockInput {
    constructor(_options: unknown) {
      mediaMocks.inputs();
    }
    async getPrimaryVideoTrack() {
      mediaMocks.trackStarted?.();
      await mediaMocks.trackGate;
      return {
        displayWidth: 640,
        displayHeight: 360,
        canDecode: async () => true,
        getFirstTimestamp: async () => 0,
        computeDuration: async () => 1,
      };
    }
    [Symbol.dispose]() {
      mediaMocks.disposed();
    }
  }
  class MockCanvasSink {
    constructor(_track: unknown, _options?: unknown) {}
    async *canvasesAtTimestamps(_timestamps: number[]) {
      mediaMocks.canvasStarted?.();
      await mediaMocks.canvasGate;
    }
    async getCanvas(timestamp: number) {
      mediaMocks.canvasStarted?.();
      await mediaMocks.canvasGate;
      return {
        canvas: new OffscreenCanvas(640, 360),
        timestamp,
        duration: 1 / 30,
      };
    }
  }
  return {
    Input: MockInput,
    ALL_FORMATS: [],
    BlobSource: class {},
    UrlSource: class {},
    CanvasSink: MockCanvasSink,
  };
});

function findFrameAtOrBefore(
  frames: Array<{ timestamp: number }>,
  timestamp: number,
): number {
  let result = 0;
  for (let index = 0; index < frames.length; index++) {
    if (frames[index]!.timestamp > timestamp) break;
    result = index;
  }
  return result;
}

describe("ExportFrameDecoder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mediaMocks.disposed.mockClear();
    mediaMocks.inputs.mockClear();
    mediaMocks.trackGate = null;
    mediaMocks.trackStarted = null;
    mediaMocks.canvasGate = null;
    mediaMocks.canvasStarted = null;
    vi.restoreAllMocks();
  });

  it("shares the four-decoder budget and disposes the least-recent export decoder", async () => {
    const engine = new MediaBunnyEngine();
    await engine.initialize();
    const before = videoDecoderBudget.size;

    for (let index = 0; index < 6; index += 1) {
      expect(await engine.createExportDecoder(`source-${index}`, new Blob([`video-${index}`]))).not.toBeNull();
    }

    expect(videoDecoderBudget.size).toBe(before + 4);
    expect(mediaMocks.disposed).toHaveBeenCalledTimes(2);
    expect(engine.getExportDecoder("source-0")).toBeNull();
    expect(engine.getExportDecoder("source-1")).toBeNull();
    expect(engine.getExportDecoder("source-5")).not.toBeNull();

    engine.disposeAllExportDecoders();
    expect(videoDecoderBudget.size).toBe(before);
  });

  it("deduplicates concurrent initialization for one export source", async () => {
    const engine = new MediaBunnyEngine();
    await engine.initialize();
    const before = videoDecoderBudget.size;

    const [first, second] = await Promise.all([
      engine.createExportDecoder("shared-source", new Blob(["first"])),
      engine.createExportDecoder("shared-source", new Blob(["second"])),
    ]);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(mediaMocks.inputs).toHaveBeenCalledTimes(1);
    expect(videoDecoderBudget.size).toBe(before + 1);
    engine.disposeAllExportDecoders();
    expect(videoDecoderBudget.size).toBe(before);
  });

  it("keeps a pinned onboarding preview inside the same four-slot export budget", async () => {
    const before = videoDecoderBudget.size;
    const onboardingLease = videoDecoderBudget.reserve(() => {});
    expect(onboardingLease).not.toBeNull();
    const engine = new MediaBunnyEngine();
    await engine.initialize();

    for (let index = 0; index < 4; index += 1) {
      expect(await engine.createExportDecoder(`export-${index}`, new Blob([`export-${index}`]))).not.toBeNull();
      expect(videoDecoderBudget.size).toBeLessThanOrEqual(before + 4);
    }

    expect(videoDecoderBudget.size).toBe(before + 4);
    expect(onboardingLease!.active).toBe(true);
    expect(engine.getExportDecoder("export-0")).toBeNull();
    expect(engine.getExportDecoder("export-3")).not.toBeNull();

    onboardingLease!.release();
    engine.disposeAllExportDecoders();
    expect(videoDecoderBudget.size).toBe(before);
  });

  it("keeps an initializing export decoder reserved while competing sources arrive", async () => {
    const before = videoDecoderBudget.size;
    const idleLeases: VideoDecoderLease[] = [];
    for (let index = 0; index < videoDecoderBudget.limit - before - 1; index += 1) {
      const lease = videoDecoderBudget.reserve(() => {});
      expect(lease).not.toBeNull();
      lease!.unpin();
      idleLeases.push(lease!);
    }

    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let finishInitialization!: () => void;
    mediaMocks.trackGate = new Promise<void>((resolve) => { finishInitialization = resolve; });
    mediaMocks.trackStarted = signalStarted;

    const engine = new MediaBunnyEngine();
    await engine.initialize();
    const borrowing = engine.acquireExportDecoder("slow-source", new Blob(["slow"]));
    await started;
    expect(videoDecoderBudget.size).toBe(videoDecoderBudget.limit);

    const competing = videoDecoderBudget.reserve(() => {});
    expect(competing).not.toBeNull();
    expect(videoDecoderBudget.size).toBe(videoDecoderBudget.limit);
    finishInitialization();

    const borrowed = await borrowing;
    expect(borrowed).not.toBeNull();
    const another = videoDecoderBudget.reserve(() => {});
    expect(another).not.toBeNull();
    expect(engine.getExportDecoder("slow-source")).toBe(borrowed!.decoder);

    borrowed!.release();
    competing!.release();
    another!.release();
    for (const lease of idleLeases) lease.release();
    engine.disposeAllExportDecoders();
    expect(videoDecoderBudget.size).toBe(before);
  });

  it("does not lend an export decoder that was evicted before a borrower resumed", async () => {
    const engine = new MediaBunnyEngine();
    const decoder = {} as ExportFrameDecoder;
    const lease = videoDecoderBudget.reserve(() => {});
    expect(lease).not.toBeNull();
    lease!.unpin();
    const internal = engine as unknown as {
      exportDecoders: Map<string, { decoder: ExportFrameDecoder; lease: VideoDecoderLease }>;
    };
    internal.exportDecoders.set("raced-source", { decoder, lease: lease! });
    vi.spyOn(engine, "createExportDecoder").mockImplementation(async () => {
      lease!.release();
      internal.exportDecoders.delete("raced-source");
      return decoder;
    });

    await expect(engine.acquireExportDecoder("raced-source", new Blob(["race"]))).resolves.toBeNull();
    expect(lease!.active).toBe(false);
  });

  it("counts direct CanvasSink frame decoding while the temporary decoder is live", async () => {
    const drawImage = vi.fn();
    vi.stubGlobal("OffscreenCanvas", class {
      width: number;
      height: number;
      constructor(width: number, height: number) { this.width = width; this.height = height; }
      getContext() { return { drawImage }; }
    });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let finishCanvas!: () => void;
    mediaMocks.canvasGate = new Promise<void>((resolve) => { finishCanvas = resolve; });
    mediaMocks.canvasStarted = signalStarted;
    const engine = new MediaBunnyEngine();
    await engine.initialize();
    const before = videoDecoderBudget.size;

    const result = engine.getFrameAtTime(new Blob(["video"]), 2);
    await started;
    expect(videoDecoderBudget.size).toBe(before + 1);
    finishCanvas();
    await expect(result).resolves.toMatchObject({ timestamp: 2, width: 640, height: 360 });
    expect(videoDecoderBudget.size).toBe(before);
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["thumbnail generation", (engine: MediaBunnyEngine) => engine.generateThumbnails(new Blob(["video"]), 1)],
    ["filmstrip generation", (engine: MediaBunnyEngine) => engine.generateFilmstripThumbnails(new Blob(["video"]), 1)],
    ["image sequence export", (engine: MediaBunnyEngine) => engine.exportImageSequence(new Blob(["video"]), 0, 1, 1)],
  ])("counts %s against the shared four-slot budget", async (_name, run) => {
    const baseline = videoDecoderBudget.size;
    const otherOwners: VideoDecoderLease[] = [];
    while (videoDecoderBudget.size < videoDecoderBudget.limit - 1) {
      const lease = videoDecoderBudget.reserve(() => {});
      expect(lease).not.toBeNull();
      otherOwners.push(lease!);
    }

    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let finishCanvas!: () => void;
    mediaMocks.canvasGate = new Promise<void>((resolve) => { finishCanvas = resolve; });
    mediaMocks.canvasStarted = signalStarted;

    const engine = new MediaBunnyEngine();
    await engine.initialize();
    const result = run(engine);
    await started;
    expect(videoDecoderBudget.size).toBe(videoDecoderBudget.limit);
    expect(videoDecoderBudget.reserve(() => {})).toBeNull();

    finishCanvas();
    await expect(result).resolves.toEqual([]);
    expect(videoDecoderBudget.size).toBe(videoDecoderBudget.limit - 1);
    for (const lease of otherOwners) lease.release();
    expect(videoDecoderBudget.size).toBe(baseline);
  });

  it("rejects thumbnail decoding before opening an input when every decoder is pinned", async () => {
    const leases: VideoDecoderLease[] = [];
    while (videoDecoderBudget.size < videoDecoderBudget.limit) {
      const lease = videoDecoderBudget.reserve(() => {});
      expect(lease).not.toBeNull();
      leases.push(lease!);
    }

    mediaMocks.inputs.mockClear();
    const engine = new MediaBunnyEngine();
    await engine.initialize();
    await expect(engine.generateThumbnails(new Blob(["video"]), 1)).rejects.toThrow(/capacity/);
    expect(mediaMocks.inputs).not.toHaveBeenCalled();
    for (const lease of leases) lease.release();
  });

  it("decodes monotonic export requests through one sequential canvas iterator", async () => {
    const drawImage = vi.fn();
    class MockOffscreenCanvas {
      width: number;
      height: number;

      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }

      getContext() {
        return { clearRect: vi.fn(), drawImage };
      }
    }
    vi.stubGlobal("OffscreenCanvas", MockOffscreenCanvas);

    const frames = [0, 1 / 30, 2 / 30, 3 / 30].map((timestamp) => ({
      canvas: new MockOffscreenCanvas(640, 360),
      timestamp,
      duration: 1 / 30,
    }));
    const getCanvas = vi.fn();
    const canvases = vi.fn((startTimestamp: number) => {
      const startIndex = findFrameAtOrBefore(frames, startTimestamp);
      return (async function* () {
        for (const frame of frames.slice(startIndex)) yield frame;
      })();
    });
    class MockCanvasSink {
      getCanvas = getCanvas;
      canvases = canvases;
    }
    class MockInput {
      async getPrimaryVideoTrack() {
        return {
          displayWidth: 640,
          displayHeight: 360,
          canDecode: vi.fn().mockResolvedValue(true),
        };
      }
    }

    const mediabunny = {
      Input: MockInput,
      ALL_FORMATS: [],
      BlobSource: class {},
      CanvasSink: MockCanvasSink,
    } as unknown as typeof import("mediabunny");
    const decoder = new ExportFrameDecoder(mediabunny, new Blob(["video"]), 640);

    expect(await decoder.initialize()).toBe(true);
    await decoder.getFrame(0);
    await decoder.getFrame(1 / 60);
    await decoder.getFrame(2 / 60);
    await decoder.getFrame(3 / 60);

    expect(canvases).toHaveBeenCalledTimes(1);
    expect(getCanvas).not.toHaveBeenCalled();
    expect(drawImage).toHaveBeenCalledTimes(4);
    expect(drawImage).toHaveBeenNthCalledWith(1, frames[0]!.canvas, 0, 0);
    expect(drawImage).toHaveBeenNthCalledWith(2, frames[0]!.canvas, 0, 0);
    expect(drawImage).toHaveBeenNthCalledWith(3, frames[1]!.canvas, 0, 0);
    expect(drawImage).toHaveBeenNthCalledWith(4, frames[1]!.canvas, 0, 0);
  });

  it("starts a new iterator when a later request moves backwards", async () => {
    class MockOffscreenCanvas {
      width: number;
      height: number;

      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }

      getContext() {
        return { clearRect: vi.fn(), drawImage: vi.fn() };
      }
    }
    vi.stubGlobal("OffscreenCanvas", MockOffscreenCanvas);

    const frames = [0, 1, 2].map((timestamp) => ({
      canvas: new MockOffscreenCanvas(320, 180),
      timestamp,
      duration: 1,
    }));
    const canvases = vi.fn((startTimestamp: number) => {
      const startIndex = findFrameAtOrBefore(frames, startTimestamp);
      return (async function* () {
        for (const frame of frames.slice(startIndex)) yield frame;
      })();
    });
    class MockCanvasSink {
      canvases = canvases;
    }
    class MockInput {
      async getPrimaryVideoTrack() {
        return {
          displayWidth: 320,
          displayHeight: 180,
          canDecode: vi.fn().mockResolvedValue(true),
        };
      }
    }

    const decoder = new ExportFrameDecoder({
      Input: MockInput,
      ALL_FORMATS: [],
      BlobSource: class {},
      CanvasSink: MockCanvasSink,
    } as unknown as typeof import("mediabunny"), new Blob(["video"]));

    await decoder.initialize();
    await decoder.getFrame(1.5);
    await decoder.getFrame(0.25);

    expect(canvases).toHaveBeenNthCalledWith(1, 1.5);
    expect(canvases).toHaveBeenNthCalledWith(2, 0.25);
  });
});
