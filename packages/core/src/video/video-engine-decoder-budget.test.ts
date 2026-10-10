import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../media/native-media-bridge", () => ({
  nativeVideoUrl: vi.fn(async () => "blob:video-engine-test"),
}));

class FakeVideo {
  src = "";
  muted = false;
  playsInline = false;
  preload = "none";
  crossOrigin: string | null = null;
  readyState = 0;
  videoWidth = 640;
  videoHeight = 360;
  duration = 10;
  onloadedmetadata: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private time = 0;
  private listeners = new Map<string, Set<() => void>>();
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();

  get currentTime(): number { return this.time; }
  set currentTime(value: number) {
    this.time = value;
    if (this.readyState >= 2) this.dispatch("seeked");
  }

  addEventListener(event: string, listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeEventListener(event: string, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  dispatch(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

describe("VideoEngine decoder cache", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("makes concurrent frame requests join metadata initialization before seeking", async () => {
    vi.useFakeTimers();
    const video = new FakeVideo();
    const createElement = vi.fn(() => video);
    vi.stubGlobal("self", {});
    vi.stubGlobal("document", { createElement });
    vi.stubGlobal("OffscreenCanvas", class {
      width: number;
      height: number;
      constructor(width: number, height: number) { this.width = width; this.height = height; }
      getContext() { return { fillRect: vi.fn(), drawImage: vi.fn(), imageSmoothingEnabled: true, imageSmoothingQuality: "high" }; }
    });
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close: vi.fn() })));
    const { VideoEngine } = await import("./video-engine");
    const engine = new VideoEngine();

    const first = engine.decodeFrameWithVideoElement("asset", new Blob(["source"]), 1, 320, 180);
    await vi.waitFor(() => expect(createElement).toHaveBeenCalledTimes(1));
    const second = engine.decodeFrameWithVideoElement("asset", new Blob(["source"]), 2, 320, 180);

    expect(video.currentTime).toBe(0);
    video.readyState = 2;
    video.onloadedmetadata?.(new Event("loadedmetadata"));
    await vi.waitFor(() => expect(video.currentTime).toBe(2));
    await Promise.all([first, second]);

    expect(createElement).toHaveBeenCalledTimes(1);
    engine.clearVideoElementCache();
  });
});
