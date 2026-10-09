import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindNativeMediaSources,
  getNativeMediaSource,
  VideoDecoderBudget,
  type MediaItem,
} from "@licketysplit/core";
import {
  createMissingMediaItem,
  generateThumbnailFromBlob,
  restoreMediaItem,
} from "./media-recovery";

function mockCreateObjectURL(
  implementation: (blob: Blob) => string = () => "blob:thumbnail",
) {
  const mock = vi.fn(implementation);
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: mock,
  });
  return mock;
}

function mediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "media-1",
    name: "clip.png",
    type: "image",
    fileHandle: null,
    blob: null,
    metadata: {
      duration: 0,
      width: 1920,
      height: 1080,
      frameRate: 0,
      codec: "png",
      sampleRate: 0,
      channels: 0,
      fileSize: 5,
    },
    thumbnailUrl: "blob:stale-thumbnail",
    waveformData: null,
    filmstripThumbnails: [
      { timestamp: 0, url: "blob:stale-filmstrip" },
    ],
    sourceFile: {
      name: "clip.png",
      size: 5,
      lastModified: 123,
    },
    ...overrides,
  };
}

describe("media recovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(URL, "createObjectURL");
  });

  it("marks a JSON blob placeholder as missing without creating an object URL", async () => {
    const createObjectURL = mockCreateObjectURL();
    const item = mediaItem({
      blob: {} as Blob,
      fileHandle: {} as FileSystemFileHandle,
      waveformData: {} as Float32Array,
    });

    const restored = await restoreMediaItem(item, undefined);

    expect(restored).toMatchObject({
      id: "media-1",
      fileHandle: null,
      blob: null,
      thumbnailUrl: null,
      waveformData: null,
      isPlaceholder: true,
    });
    expect(restored.filmstripThumbnails).toBeUndefined();
    expect(restored.sourceFile).toEqual(item.sourceFile);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("restores an IndexedDB blob instead of the serialized placeholder", async () => {
    const storedBlob = new Blob(["image"], { type: "image/png" });
    const createObjectURL = mockCreateObjectURL(
      () => "blob:restored-thumbnail",
    );
    const item = mediaItem({ blob: {} as Blob, isPlaceholder: true });

    const restored = await restoreMediaItem(item, storedBlob);

    expect(restored.blob).toBe(storedBlob);
    expect(restored.thumbnailUrl).toBe("blob:restored-thumbnail");
    expect(restored.isPlaceholder).toBe(false);
    expect(createObjectURL).toHaveBeenCalledWith(storedBlob);
  });

  it("keeps recovered media usable when thumbnail regeneration fails", async () => {
    const storedBlob = new Blob(["image"], { type: "image/png" });
    mockCreateObjectURL(() => {
      throw new TypeError("thumbnail failure");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const restored = await restoreMediaItem(mediaItem(), storedBlob);

    expect(restored.blob).toBe(storedBlob);
    expect(restored.thumbnailUrl).toBeNull();
    expect(restored.isPlaceholder).toBe(false);
  });

  it("restores a native video reference without decoding an empty placeholder blob", async () => {
    const nativeBlob = new Blob([]);
    const uri = "licketysplit-media://camera/original";
    bindNativeMediaSources(nativeBlob, Promise.resolve(uri), Promise.resolve(uri));
    const createObjectURL = mockCreateObjectURL();
    const createElement = vi.spyOn(document, "createElement");
    const item = mediaItem({
      type: "video",
      name: "camera.mov",
      blob: null,
      thumbnailUrl: "blob:old-thumbnail",
      filmstripThumbnails: [{ timestamp: 1, url: "blob:old-filmstrip" }],
    });

    const restored = await restoreMediaItem(item, nativeBlob);

    expect(restored).toMatchObject({
      blob: nativeBlob,
      thumbnailUrl: null,
      isPlaceholder: false,
    });
    expect(restored.filmstripThumbnails).toBeUndefined();
    expect(await getNativeMediaSource(restored.blob!, "preview")).toBe(uri);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(createElement).not.toHaveBeenCalledWith("video");
  });

  it("bounds simultaneous browser video thumbnail recovery with shared decoder slots", async () => {
    const budget = new VideoDecoderBudget(4);
    const videos: Array<{
      onloadeddata: ((event: Event) => void) | null;
      onseeked: ((event: Event) => void) | null;
      fireLoaded(): void;
    }> = [];
    let activeVideos = 0;
    let maximumActiveVideos = 0;
    let urlId = 0;
    mockCreateObjectURL(() => `blob:thumbnail-test-${++urlId}`);

    const videoFactory = () => {
      activeVideos += 1;
      maximumActiveVideos = Math.max(maximumActiveVideos, activeVideos);
      let currentTime = 0;
      let disposed = false;
      const video = {
        muted: false,
        playsInline: false,
        preload: "none",
        src: "",
        videoWidth: 640,
        videoHeight: 360,
        onloadeddata: null as ((event: Event) => void) | null,
        onseeked: null as ((event: Event) => void) | null,
        onerror: null as ((event: Event) => void) | null,
        pause: vi.fn(),
        removeAttribute: vi.fn((name: string) => {
          if (name === "src" && !disposed) {
            disposed = true;
            activeVideos -= 1;
          }
        }),
        load: vi.fn(),
        get currentTime() {
          return currentTime;
        },
        set currentTime(value: number) {
          currentTime = value;
          this.onseeked?.(new Event("seeked"));
        },
        fireLoaded() {
          this.onloadeddata?.(new Event("loadeddata"));
        },
      };
      videos.push(video);
      return video as unknown as HTMLVideoElement;
    };
    const canvasFactory = () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (callback: (blob: Blob | null) => void) => callback(new Blob(["thumbnail"])),
    }) as unknown as HTMLCanvasElement;

    const recoveries = Array.from({ length: 8 }, () =>
      generateThumbnailFromBlob(new Blob(["camera"]), "video", {
        budget,
        videoFactory,
        canvasFactory,
      }),
    );
    await vi.waitFor(() => expect(videos).toHaveLength(4));
    expect(budget.size).toBe(4);
    expect(maximumActiveVideos).toBeLessThanOrEqual(4);

    for (const video of videos) video.fireLoaded();
    const thumbnails = await Promise.all(recoveries);

    expect(thumbnails.filter(Boolean)).toHaveLength(4);
    expect(thumbnails.filter((thumbnail) => thumbnail === null)).toHaveLength(4);
    expect(maximumActiveVideos).toBe(4);
    expect(activeVideos).toBe(0);
    expect(budget.size).toBe(0);
  });

  it("rejects non-Blob input at the thumbnail boundary", async () => {
    const createObjectURL = mockCreateObjectURL();

    await expect(
      generateThumbnailFromBlob({} as Blob, "image"),
    ).resolves.toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("creates a relinkable placeholder while preserving source hints", () => {
    const item = mediaItem();

    expect(createMissingMediaItem(item)).toMatchObject({
      id: item.id,
      blob: null,
      isPlaceholder: true,
      sourceFile: item.sourceFile,
    });
  });
});
