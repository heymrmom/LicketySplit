import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "@licketysplit/core";

const { resolveDesktopOriginalPreview } = vi.hoisted(() => ({ resolveDesktopOriginalPreview: vi.fn(async () => "licketysplit-media://mic/original") }));

vi.mock("./desktop-media", () => ({
  resolveDesktopOriginalPreview,
  registerDesktopMedia: vi.fn(async (item: MediaItem) => ({ identity: { assetId: item.id, mediaId: item.id, sha256: "hash", byteLength: 1 }, originalUri: "licketysplit-media://mic/original" })),
}));

const eligibleMic = (): MediaItem => ({
  id: "mic", name: "mic.wav", type: "audio", fileHandle: null, blob: null, thumbnailUrl: null, waveformData: null,
  metadata: { duration: 61, width: 0, height: 0, frameRate: 0, codec: "pcm_s24le", sampleRate: 44100, channels: 1, fileSize: 10, hasAudio: true, hasVideo: false, audioTrackCount: 1, container: "wav" },
});

describe("desktop audio preview", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); delete (window as unknown as { licketysplit?: unknown }).licketysplit; });

  it("uses a validated original WAV while registration and AAC preparation are unavailable", async () => {
    const { isEligibleOriginalMonoWav, resolveDesktopAudioPreview } = await import("./desktop-audio-preview");
    const item = eligibleMic();
    const ensureAudioStream = vi.fn(async () => { throw new Error("AAC preparation is blocked"); });
    Object.assign(window, { licketysplit: { platform: "desktop", lickety: { ensureAudioStream } } });

    expect(isEligibleOriginalMonoWav(item, 0, 0)).toBe(true);
    await expect(resolveDesktopAudioPreview(item, 0, 0)).resolves.toBe("licketysplit-media://mic/original");
    expect(resolveDesktopOriginalPreview).toHaveBeenCalledWith(item);
    expect(ensureAudioStream).not.toHaveBeenCalled();
  });

  it("does not return a resolved URI after its source request becomes stale", async () => {
    const { resolveDesktopAudioPreview } = await import("./desktop-audio-preview");
    let finish!: (uri: string) => void;
    resolveDesktopOriginalPreview.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    let current = true;
    const pending = resolveDesktopAudioPreview(eligibleMic(), 0, 0, { priority: "foreground" }, () => current);
    current = false;
    finish("licketysplit-media://stale/original");
    await expect(pending).resolves.toBeUndefined();
  });

  it("does not publish a held timeline URI after the selected source changes away and back", async () => {
    const { prepareTimelineNativeAudioPreview } = await import("./desktop-audio-preview");
    let finish!: (uri: string) => void;
    resolveDesktopOriginalPreview.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    let selectedGeneration = 1;
    const publish = vi.fn();
    const pending = prepareTimelineNativeAudioPreview(eligibleMic(), 0, 0, () => selectedGeneration === 1, publish);
    selectedGeneration = 3; // A -> B -> A; identity alone does not make the old request current.
    finish("licketysplit-media://mic/original");
    await expect(pending).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  });

  it("requires selected inspected stream proof before using the whole WAV", async () => {
    const { resolveDesktopAudioPreview } = await import("./desktop-audio-preview");
    const ensureAudioStream = vi.fn(async () => "file:///isolated-stream.aac");
    Object.assign(window, { licketysplit: { platform: "desktop", lickety: { ensureAudioStream } } });
    await expect(resolveDesktopAudioPreview(eligibleMic(), 0, 0, { priority: "foreground" }, () => true, false)).resolves.toBe("file:///isolated-stream.aac");
    expect(ensureAudioStream).toHaveBeenCalledOnce();
    expect(resolveDesktopOriginalPreview).not.toHaveBeenCalled();
  });

  it.each([
    ["unproven container", { container: undefined }],
    ["multichannel", { channels: 2 }],
    ["multiple tracks", { audioTrackCount: 2 }],
    ["encoded audio", { codec: "aac" }],
    ["video source", { hasVideo: true }],
  ])("rejects original WAV bypass for %s", async (_label, metadataPatch) => {
    const { isEligibleOriginalMonoWav } = await import("./desktop-audio-preview");
    expect(isEligibleOriginalMonoWav({ ...eligibleMic(), metadata: { ...eligibleMic().metadata, ...metadataPatch } }, 0, 0)).toBe(false);
  });

  it("keeps multichannel channel isolation on the existing AAC preparation path", async () => {
    const { resolveDesktopAudioPreview } = await import("./desktop-audio-preview");
    const item = { ...eligibleMic(), metadata: { ...eligibleMic().metadata, channels: 2 } };
    const ensureAudioStream = vi.fn(async () => "file:///isolated-channel.aac");
    Object.assign(window, { licketysplit: { platform: "desktop", lickety: { ensureAudioStream } } });
    await expect(resolveDesktopAudioPreview(item, 1, 1, { priority: "foreground" })).resolves.toBe("file:///isolated-channel.aac");
    expect(ensureAudioStream).toHaveBeenCalledWith("mic", 1, 1, { priority: "foreground" });
    expect(resolveDesktopOriginalPreview).not.toHaveBeenCalled();
  });
});
