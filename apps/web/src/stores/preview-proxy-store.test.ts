import "../test/install-local-storage-mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaImportService, getMediaEngine, type MediaItem } from "@licketysplit/core";
import { createEmptyProject } from "./project/project-helpers";
import { useProjectStore } from "./project-store";
import { getMediaBridge } from "../bridges/media-bridge";
import { getReadyNativePreviewUri, previewProxyCache, publishNativePreviewAtBoundary, retryNativePreviewPreparation } from "./preview-proxy-store";
import { useTimelineStore } from "./timeline-store";

afterEach(() => {
  useProjectStore.setState({ hasOpenProject: false, project: createEmptyProject("Reset") });
  useTimelineStore.setState({ playbackState: "stopped", playheadPosition: 0 });
  vi.restoreAllMocks();
});

describe("project/export proxy isolation", () => {
  it("passes original library blobs through getFullProject for export and clears session proxies on relink/close", async () => {
    const original = new Blob(["original-source"]);
    const proxy = new Blob(["proxy"]);
    const item: MediaItem = {
      id: "source", name: "Source.mp4", type: "video", blob: original, fileHandle: null, waveformData: null, thumbnailUrl: null,
      metadata: { width: 1920, height: 1080, duration: 2, frameRate: 30, codec: "avc", sampleRate: 48000, channels: 2, fileSize: original.size },
    };
    const project = createEmptyProject("Proxy export");
    const loaded = { ...project, mediaLibrary: { ...project.mediaLibrary, items: [item] } };
    vi.spyOn(MediaImportService.prototype, "initialize").mockResolvedValue();
    vi.spyOn(MediaImportService.prototype, "generateProxyWithPreset").mockResolvedValue(proxy);
    vi.spyOn(getMediaEngine(), "extractMetadata").mockResolvedValue({ ...item.metadata, hasVideo: true, hasAudio: true, canDecode: true, canDecodeVideo: true, rotation: 0, mimeType: "video/mp4", width: 1280, height: 720 });
    useProjectStore.setState({ hasOpenProject: true, project: loaded });
    previewProxyCache.request(item, "medium");
    await vi.waitFor(() => expect(previewProxyCache.store.getState().entries[item.id]?.status).toBe("ready"));
    expect(previewProxyCache.resolve(loaded.id, useProjectStore.getState().getMediaItem(item.id)!).blob).toBe(proxy);
    expect(useProjectStore.getState().getFullProject().mediaLibrary.items[0].blob).toBe(original);
    expect(useProjectStore.getState().getMediaItem(item.id)?.blob).toBe(original);
    // This is the same path as double-clicking a library thumbnail. Both the
    // new track and its clip must retain the existing proxy/source identity.
    const added = await useProjectStore.getState().addClipToNewTrack(item.id, 0);
    expect(added.success).toBe(true);
    expect(previewProxyCache.store.getState().entries[item.id]?.status).toBe("ready");
    expect(previewProxyCache.resolve(loaded.id, useProjectStore.getState().getMediaItem(item.id)!).blob).toBe(proxy);
    expect(useProjectStore.getState().getFullProject().mediaLibrary.items[0].blob).toBe(original);
    const track = useProjectStore.getState().project.timeline.tracks.find((track) => track.clips.length > 0)!;
    const duplicated = await useProjectStore.getState().duplicateTrack(track.id);
    expect(duplicated.success).toBe(true);
    const placed = await useProjectStore.getState().placeMediaClip(item.id, track.id, 2);
    expect(placed.success).toBe(true);
    const duplicate = await useProjectStore.getState().duplicateClip(track.clips[0].id);
    expect(duplicate.success).toBe(true);
    await useProjectStore.getState().undo();
    await useProjectStore.getState().redo();
    expect(previewProxyCache.resolve(loaded.id, useProjectStore.getState().getMediaItem(item.id)!).blob).toBe(proxy);
    // Identical names/metadata do not make a relinked Blob the same source.
    const replacement = { ...item, blob: new Blob(["relinked"]) };
    useProjectStore.setState({ project: { ...loaded, mediaLibrary: { ...loaded.mediaLibrary, items: [replacement] } } });
    expect(previewProxyCache.store.getState().entries[item.id]).toBeUndefined();
    expect(previewProxyCache.resolve(loaded.id, replacement)).toBe(replacement);
    useProjectStore.setState({ hasOpenProject: false });
    expect(previewProxyCache.store.getState().projectId).toBeNull();
  });
});

it("stages a completed native proxy until playback is paused, then publishes it", async () => {
  const { makeWorkflowFixture } = await import("@licketysplit/core/lickety/test-fixtures");
  const { useUIStore } = await import("./ui-store");
  const fixture = makeWorkflowFixture();
  const source = fixture.mediaLibrary.items.find((candidate) => candidate.id === "cam-a")!;
  const item = { ...source, blob: new Blob(["original"]), thumbnailUrl: "data:image/png;base64,fixture", nativeSource: { identity: { assetId: "asset-cam-a", mediaId: source.id, sha256: "sha", byteLength: 8 }, originalUri: `licketysplit-media://${source.id}/original`, durationMs: 20_000 }, metadata: { ...source.metadata, width: 3840, height: 2160, canDecodeVideo: true } };
  let finishProxy!: (receipt: object) => void;
  const ensureProxy = vi.fn(() => new Promise<object>((resolve) => { finishProxy = resolve; }));
  Object.assign(window, { licketysplit: { platform: "desktop", lickety: { originalPreviewUri: async () => `licketysplit-media://${source.id}/original`, originalUri: async () => `licketysplit-media://${source.id}/original`, findAsset: async () => item.nativeSource, resolve: async (assetId: string) => `licketysplit-media://${assetId}/original`, resourceProfile: async () => ({ lowMemory: true }), ensureProxy, cancelMedia: vi.fn(async () => undefined) } } });
  useTimelineStore.setState({ playbackState: "playing" });
  useUIStore.setState({ selectedItems: [] });
  useProjectStore.setState({ hasOpenProject: true, project: { ...fixture, timeline: { ...fixture.timeline, tracks: [] }, mediaLibrary: { ...fixture.mediaLibrary, items: [item] } } });
  expect(useProjectStore.getState().hasOpenProject).toBe(true);
  expect(item.type).toBe("video");
  previewProxyCache.request(item, "low");
  await vi.waitFor(() => expect(ensureProxy).toHaveBeenCalledOnce());
  const originalDuringOptimization = previewProxyCache.resolve(fixture.id, item);
  expect(originalDuringOptimization.blob).toBe(item.blob);
  const { getNativeMediaSource } = await import("@licketysplit/core");
  expect(await getNativeMediaSource(originalDuringOptimization.blob!, "preview")).toBe(`licketysplit-media://${source.id}/original`);
  const revisionBeforeProxy = previewProxyCache.store.getState().revision;
  finishProxy({ assetId: "asset-cam-a", sourceSha256: "sha", proxyUri: "licketysplit-media://asset-cam-a/proxy", version: 1, width: 960, height: 540, sourceStartPTS: 0, proxyStartPTS: 0, durationMs: 20_000 });
  await vi.waitFor(() => expect(previewProxyCache.store.getState().entries[source.id]?.status).toBe("ready"));
  expect(previewProxyCache.store.getState().revision).toBe(revisionBeforeProxy);
  expect(getReadyNativePreviewUri(fixture.id, item)).toBeUndefined();
  expect(publishNativePreviewAtBoundary(fixture.id, item)).toBe(false);
  useTimelineStore.setState({ playbackState: "paused" });
  expect(getReadyNativePreviewUri(fixture.id, item)).toBe("licketysplit-media://asset-cam-a/proxy");
  expect(await getNativeMediaSource(originalDuringOptimization.blob!, "preview")).toBe("licketysplit-media://asset-cam-a/proxy");
  expect(previewProxyCache.store.getState().revision).toBe(revisionBeforeProxy + 1);
  delete window.licketysplit;
  useUIStore.setState({ selectedItems: [] });
});

it("starts at most one forced proxy after a validated native original fails decoding", async () => {
  const { makeWorkflowFixture } = await import("@licketysplit/core/lickety/test-fixtures");
  const { useUIStore } = await import("./ui-store");
  useTimelineStore.setState({ playbackState: "playing" });
  const { handleNativeOriginalPreviewFailure } = await import("./preview-proxy-store");
  const fixture = makeWorkflowFixture();
  const source = fixture.mediaLibrary.items.find((candidate) => candidate.id === "cam-a")!;
  const item = { ...source, blob: new Blob(["original"]), thumbnailUrl: "data:image/png;base64,fixture", nativeSource: { identity: { assetId: "asset-cam-a", mediaId: source.id, sha256: "sha", byteLength: 8 }, originalUri: `licketysplit-media://${source.id}/original`, durationMs: 20_000 }, metadata: { ...source.metadata, width: 3840, height: 2160, canDecodeVideo: true } };
  const ensureProxy = vi.fn(async (assetId: string) => ({ assetId, sourceSha256: "sha", proxyUri: `licketysplit-media://${assetId}/proxy`, version: 1, width: 640, height: 360, sourceStartPTS: 0, proxyStartPTS: 0, durationMs: 20_000 }));
  Object.assign(window, { licketysplit: { platform: "desktop", lickety: { originalPreviewUri: async () => `licketysplit-media://${source.id}/original`, originalUri: async () => `licketysplit-media://${source.id}/original`, resourceProfile: async () => ({ lowMemory: true }), ensureProxy, resolve: async (assetId: string) => `licketysplit-media://${assetId}/original`, cancelMedia: vi.fn(async () => undefined) } } });
  useUIStore.setState({ selectedItems: [{ type: "clip", id: item.id }] });
  useProjectStore.setState({ hasOpenProject: true, project: { ...fixture, timeline: { ...fixture.timeline, tracks: [] }, mediaLibrary: { ...fixture.mediaLibrary, items: [item] } } });
  await vi.waitFor(() => expect(previewProxyCache.store.getState().entries[item.id]?.originalAvailable).toBe(true));
  expect(useProjectStore.getState().getMediaItem(item.id)).toBe(item);
  const { getNativeMediaSource } = await import("@licketysplit/core");
  expect(await getNativeMediaSource(item.blob!, "preview")).toBe(`licketysplit-media://${source.id}/original`);
  expect(handleNativeOriginalPreviewFailure(fixture.id, item, `licketysplit-media://${source.id}/original`)).toBe("fallback-started");
  expect(handleNativeOriginalPreviewFailure(fixture.id, item, `licketysplit-media://${source.id}/original`)).toBe("stale");
  await vi.waitFor(() => expect(ensureProxy).toHaveBeenCalledOnce());
  delete window.licketysplit;
  useUIStore.setState({ selectedItems: [] });
});
it("prepares eligible desktop library videos in order before the first preview request", async () => {
  const { makeWorkflowFixture } = await import("@licketysplit/core/lickety/test-fixtures");
  const { useUIStore } = await import("./ui-store");
  const fixture = makeWorkflowFixture();
  const findAsset = vi.fn(async (mediaId: string) => ({ identity: { assetId: mediaId, mediaId, sha256: "sha", byteLength: 1 }, originalUri: `licketysplit-media://${mediaId}/original`, durationMs: 20_000 }));
  const ensureProxy = vi.fn(async (assetId: string) => ({ assetId, sourceSha256: "sha", proxyUri: `licketysplit-media://${assetId}/proxy`, version: 1, width: 960, height: 540, sourceStartPTS: 0, proxyStartPTS: 0, durationMs: 20_000 }));
  Object.assign(window, { licketysplit: { platform: "desktop", lickety: { findAsset, originalUri: async (mediaId: string) => `licketysplit-media://${mediaId}/original`, resourceProfile: async () => ({ lowMemory: true }), resolve: async (id: string) => `licketysplit-media://${id}/original`, ensureProxy } } });
  useUIStore.setState({ selectedItems: [] });
  useProjectStore.setState({ hasOpenProject: true, project: { ...fixture, timeline: { ...fixture.timeline, tracks: [] } } });
  await vi.waitFor(() => expect(ensureProxy).toHaveBeenCalledTimes(2));
  expect(findAsset.mock.calls.map(([mediaId]) => mediaId)).toEqual(["cam-a", "cam-b"]);
  expect(previewProxyCache.store.getState().entries["cam-a"]?.status).toBe("ready");
  expect(previewProxyCache.store.getState().entries["cam-b"]?.status).toBe("ready");
  delete window.licketysplit;
  useUIStore.setState({ selectedItems: [] });
});

it("keeps only one native background proxy request active at a time", async () => {
  const { makeWorkflowFixture } = await import("@licketysplit/core/lickety/test-fixtures");
  const { useUIStore } = await import("./ui-store");
  const fixture = makeWorkflowFixture();
  const pending: Array<{ id: string; resolve: (receipt: object) => void }> = [];
  const items = fixture.mediaLibrary.items.filter((item) => item.id === "cam-a" || item.id === "cam-b").map((item) => ({
    ...item,
    blob: new Blob([item.id]),
    nativeSource: {
      identity: { assetId: `asset-${item.id}`, mediaId: item.id, sha256: `sha-${item.id}`, byteLength: 1 },
      originalUri: `licketysplit-media://${item.id}/original`,
      durationMs: 20_000,
    },
    metadata: { ...item.metadata, width: 3840, height: 2160, canDecodeVideo: true },
  }));
  const ensureProxy = vi.fn((assetId: string, _options?: { requestId?: string; priority?: "foreground" | "background" }) => new Promise<object>((resolve) => pending.push({
    id: assetId,
    resolve: (receipt) => resolve(receipt),
  })));
  Object.assign(window, {
    licketysplit: {
      platform: "desktop",
      lickety: {
        originalUri: async (mediaId: string) => `licketysplit-media://${mediaId}/original`,
        resolve: async (assetId: string) => `licketysplit-media://${assetId}/original`,
        resourceProfile: async () => ({ lowMemory: true }),
        ensureProxy,
      },
    },
  });
  useUIStore.setState({ selectedItems: [] });
  useProjectStore.setState({ hasOpenProject: true, project: { ...fixture, mediaLibrary: { ...fixture.mediaLibrary, items }, timeline: { ...fixture.timeline, tracks: [] } } });

  await vi.waitFor(() => expect(ensureProxy).toHaveBeenCalledTimes(1));
  expect(ensureProxy.mock.calls[0][0]).toBe("asset-cam-a");
  expect(ensureProxy.mock.calls[0][1]).toEqual(expect.objectContaining({ priority: "background", requestId: expect.any(String) }));
  expect(pending).toHaveLength(1);
  pending[0].resolve({ assetId: "asset-cam-a", sourceSha256: "sha-cam-a", proxyUri: "licketysplit-media://cam-a/proxy", version: 1, width: 960, height: 540, sourceStartPTS: 0, proxyStartPTS: 0, durationMs: 20_000 });
  await vi.waitFor(() => expect(ensureProxy).toHaveBeenCalledTimes(2));
  expect(ensureProxy.mock.calls[1][0]).toBe("asset-cam-b");
  pending[1].resolve({ assetId: "asset-cam-b", sourceSha256: "sha-cam-b", proxyUri: "licketysplit-media://cam-b/proxy", version: 1, width: 960, height: 540, sourceStartPTS: 0, proxyStartPTS: 0, durationMs: 20_000 });
  await vi.waitFor(() => expect(previewProxyCache.store.getState().entries["cam-b"]?.status).toBe("ready"));
  delete window.licketysplit;
  useUIStore.setState({ selectedItems: [] });
});

it("sends only the latest selection as foreground while unrelated background work is held", async () => {
  const { makeWorkflowFixture } = await import("@licketysplit/core/lickety/test-fixtures");
  const { useUIStore } = await import("./ui-store");
  const fixture = makeWorkflowFixture();
  const template = fixture.mediaLibrary.items.find((item) => item.id === "cam-a")!;
  const items = Array.from({ length: 20 }, (_, index) => {
    const id = `camera-${index}`;
    return { ...template, id, name: `${id}.mp4`, blob: new Blob([id]), nativeSource: { identity: { assetId: `asset-${id}`, mediaId: id, sha256: `sha-${id}`, byteLength: 1 }, originalUri: `licketysplit-media://${id}/original`, durationMs: 20_000 }, metadata: { ...template.metadata, width: 3840, height: 2160, canDecodeVideo: true } };
  });
  const clipTemplate = fixture.timeline.tracks.flatMap((track) => track.clips)[0]!;
  const clips = items.map((item, index) => ({ ...clipTemplate, id: `clip-${item.id}`, mediaId: item.id, startTime: index * 5, duration: 2 }));
  const pending: Array<{ id: string; resolve: (receipt: object) => void }> = [];
  const canceled: string[] = [];
  const ensureProxy = vi.fn((assetId: string, _options?: { requestId?: string; priority?: "foreground" | "background" }) => new Promise<object>((resolve) => pending.push({ id: assetId, resolve: (receipt) => resolve(receipt) })));
  Object.assign(window, { licketysplit: { platform: "desktop", lickety: { originalUri: async (id: string) => `licketysplit-media://${id}/original`, resolve: async (id: string) => `licketysplit-media://${id}/original`, resourceProfile: async () => ({ lowMemory: true }), ensureProxy, cancelMedia: vi.fn(async (requestId: string) => { canceled.push(requestId); }) } } });
  useUIStore.setState({ selectedItems: items.map((item) => ({ type: "clip", id: `clip-${item.id}` })) });
  const tracks = fixture.timeline.tracks.map((track, index) => index === 0 ? { ...track, clips: [...track.clips, ...clips] } : track);
  useProjectStore.setState({ hasOpenProject: true, project: { ...fixture, mediaLibrary: { ...fixture.mediaLibrary, items }, timeline: { ...fixture.timeline, tracks } } });

  await vi.waitFor(() => expect(ensureProxy).toHaveBeenCalledTimes(2));
  const foreground = ensureProxy.mock.calls.find((call) => call[1]?.priority === "foreground");
  const background = ensureProxy.mock.calls.find((call) => call[1]?.priority === "background");
  expect(foreground?.[0]).toBe("asset-camera-19");
  expect(background?.[0]).toBe("asset-camera-18");
  expect(ensureProxy.mock.calls).toHaveLength(2);

  const backgroundRequest = background![1]!.requestId!;
  pending.find((request) => request.id === "asset-camera-19")!.resolve({ assetId: "asset-camera-19", sourceSha256: "sha-camera-19", proxyUri: "licketysplit-media://camera-19/proxy", version: 1, width: 960, height: 540, sourceStartPTS: 0, proxyStartPTS: 0, durationMs: 20_000 });
  await vi.waitFor(() => expect(previewProxyCache.store.getState().entries["camera-19"]?.status).toBe("ready"));

  useProjectStore.setState({ hasOpenProject: false, project: createEmptyProject("Closed") });
  await vi.waitFor(() => expect(canceled).toContain(backgroundRequest));
  for (const request of pending) request.resolve({ assetId: request.id, sourceSha256: request.id.replace("asset-", "sha-"), proxyUri: `licketysplit-media://${request.id.replace("asset-", "")}/proxy`, version: 1, width: 960, height: 540, sourceStartPTS: 0, proxyStartPTS: 0, durationMs: 20_000 });
  delete window.licketysplit;
  useUIStore.setState({ selectedItems: [] });
});

it("restarts a canceled foreground consumer when selection returns to its source", async () => {
  const { makeWorkflowFixture } = await import("@licketysplit/core/lickety/test-fixtures");
  const { useUIStore } = await import("./ui-store");
  const fixture = makeWorkflowFixture();
  const items = fixture.mediaLibrary.items.filter((item) => item.id === "cam-a" || item.id === "cam-b").map((item) => ({
    ...item,
    blob: new Blob([item.id]),
    nativeSource: { identity: { assetId: `asset-${item.id}`, mediaId: item.id, sha256: `sha-${item.id}`, byteLength: 1 }, originalUri: `licketysplit-media://${item.id}/original`, durationMs: 20_000 },
    metadata: { ...item.metadata, width: 3840, height: 2160, canDecodeVideo: true },
  }));
  const pending: Array<{ id: string; resolve: (receipt: object) => void }> = [];
  const ensureProxy = vi.fn((assetId: string, _options?: { requestId?: string; priority?: "foreground" | "background" }) => new Promise<object>((resolve) => pending.push({ id: assetId, resolve: (receipt) => resolve(receipt) })));
  Object.assign(window, { licketysplit: { platform: "desktop", lickety: { originalUri: async (id: string) => `licketysplit-media://${id}/original`, resolve: async (id: string) => `licketysplit-media://${id}/original`, resourceProfile: async () => ({ lowMemory: true }), ensureProxy, cancelMedia: vi.fn(async () => undefined) } } });
  useUIStore.setState({ selectedItems: [{ type: "clip", id: "cam-a" }] });
  useProjectStore.setState({ hasOpenProject: true, project: { ...fixture, mediaLibrary: { ...fixture.mediaLibrary, items }, timeline: { ...fixture.timeline, tracks: [] } } });
  await vi.waitFor(() => expect(ensureProxy.mock.calls.some((call) => call[0] === "asset-cam-a" && call[1]?.priority === "foreground")).toBe(true));
  useUIStore.setState({ selectedItems: [{ type: "clip", id: "cam-b" }] });
  await vi.waitFor(() => expect(ensureProxy.mock.calls.some((call) => call[0] === "asset-cam-b" && call[1]?.priority === "foreground")).toBe(true));
  useUIStore.setState({ selectedItems: [{ type: "clip", id: "cam-a" }] });
  await vi.waitFor(() => expect(ensureProxy.mock.calls.filter((call) => call[0] === "asset-cam-a" && call[1]?.priority === "foreground")).toHaveLength(2));
  const aRequests = ensureProxy.mock.calls.filter((call) => call[0] === "asset-cam-a" && call[1]?.priority === "foreground");
  expect(aRequests[0]?.[1]?.requestId).not.toBe(aRequests[1]?.[1]?.requestId);
  [...pending].reverse().find((request) => request.id === "asset-cam-a")!.resolve({ assetId: "asset-cam-a", sourceSha256: "sha-cam-a", proxyUri: "licketysplit-media://cam-a/proxy", version: 1, width: 960, height: 540, sourceStartPTS: 0, proxyStartPTS: 0, durationMs: 20_000 });
  await vi.waitFor(() => expect(previewProxyCache.store.getState().entries["cam-a"]?.status).toBe("ready"));
  delete window.licketysplit;
  useUIStore.setState({ selectedItems: [] });
});

it("retries native preview preparation after a transient original URI failure", async () => {
  const { makeWorkflowFixture } = await import("@licketysplit/core/lickety/test-fixtures");
  const { useUIStore } = await import("./ui-store");
  const fixture = makeWorkflowFixture();
  const item = fixture.mediaLibrary.items.find((candidate) => candidate.id === "cam-b")!;
  let attempts = 0;
  Object.assign(window, {
    licketysplit: {
      platform: "desktop",
      lickety: {
        originalUri: vi.fn(async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("temporary media service failure");
          return "licketysplit-media://cam-b/original";
        }),
        resourceProfile: async () => ({ lowMemory: false }),
      },
    },
  });
  useUIStore.setState({ selectedItems: [] });
  useProjectStore.setState({
    hasOpenProject: true,
    project: { ...fixture, timeline: { ...fixture.timeline, tracks: [] } },
  });
  useUIStore.setState({ selectedItems: [{ type: "clip", id: item.id }] });
  await vi.waitFor(() => expect(previewProxyCache.store.getState().entries[item.id]?.status).toBe("error"));
  expect(previewProxyCache.resolve(fixture.id, item)?.blob).toBeNull();

  await retryNativePreviewPreparation(item.id);

  await vi.waitFor(() => expect(previewProxyCache.store.getState().entries[item.id]?.status).not.toBe("encoding"));
  expect(previewProxyCache.store.getState().entries[item.id]?.status).toBe("ready");
  expect(attempts).toBe(2);
  const readyItem = previewProxyCache.resolve(fixture.id, item);
  expect(readyItem?.blob?.size).toBe(0);
  const { getNativeMediaSource } = await import("@licketysplit/core");
  expect(await getNativeMediaSource(readyItem!.blob!, "preview")).toBe("licketysplit-media://cam-b/original");
  delete window.licketysplit;
  useUIStore.setState({ selectedItems: [] });
});

it("waits for cancellation of the previous native preparation before starting its retry", async () => {
  const { makeWorkflowFixture } = await import("@licketysplit/core/lickety/test-fixtures");
  const { useUIStore } = await import("./ui-store");
  const fixture = makeWorkflowFixture();
  const item = fixture.mediaLibrary.items.find((candidate) => candidate.id === "cam-b")!;
  const identity = { assetId: "asset-cam-b", mediaId: item.id, sha256: "fixture-sha", byteLength: 1 };
  let releaseCancellation!: () => void;
  let cancellationStarted = false;
  let cancellationFinished = false;
  let originalPreparations = 0;
  Object.assign(window, {
    licketysplit: {
      platform: "desktop",
      lickety: {
        originalUri: async () => {
          if (!cancellationFinished && cancellationStarted) throw new Error("new prep raced old cancellation");
          originalPreparations += 1;
          return "licketysplit-media://cam-b/original";
        },
        resourceProfile: async () => ({ lowMemory: false }),
        cancelMedia: vi.fn(async () => {
          cancellationStarted = true;
          await new Promise<void>((resolve) => { releaseCancellation = resolve; });
          cancellationFinished = true;
        }),
      },
    },
  });
  useUIStore.setState({ selectedItems: [] });
  useProjectStore.setState({ hasOpenProject: true, project: { ...fixture, mediaLibrary: { ...fixture.mediaLibrary, items: fixture.mediaLibrary.items.map((candidate) => candidate.id === item.id ? { ...candidate, blob: new Blob(["synthetic original"]), nativeSource: { identity, originalUri: "licketysplit-media://cam-b/original", durationMs: 20000 } } : candidate) }, timeline: { ...fixture.timeline, tracks: [] } } });
  useUIStore.setState({ selectedItems: [{ type: "clip", id: item.id }] });
  await vi.waitFor(() => expect(previewProxyCache.store.getState().entries[item.id]?.status).toBe("ready"));
  expect(originalPreparations).toBe(1);

  const retry = retryNativePreviewPreparation(item.id);
  await vi.waitFor(() => expect(cancellationStarted).toBe(true));
  expect(originalPreparations).toBe(1);
  releaseCancellation();
  await retry;
  await vi.waitFor(() => expect(previewProxyCache.store.getState().entries[item.id]?.status).toBe("ready"));
  expect(originalPreparations).toBe(2);
  delete window.licketysplit;
  useUIStore.setState({ selectedItems: [] });
});

it("ignores a native preparation error after the project switches to a replacement source with the same media id", async () => {
  const { makeWorkflowFixture } = await import("@licketysplit/core/lickety/test-fixtures");
  const { useUIStore } = await import("./ui-store");
  const fixture = makeWorkflowFixture();
  const originalItem = fixture.mediaLibrary.items.find((candidate) => candidate.id === "cam-b")!;
  let rejectOldPreparation!: (error: Error) => void;
  let profileCalls = 0;
  Object.assign(window, {
    licketysplit: {
      platform: "desktop",
      lickety: {
        originalUri: async () => "licketysplit-media://cam-b/original",
        resourceProfile: async () => {
          profileCalls += 1;
          if (profileCalls === 1) {
            return new Promise< never >((_resolve, reject) => { rejectOldPreparation = reject; });
          }
          return { lowMemory: false };
        },
      },
    },
  });
  const withNoTimelineClips = { ...fixture, timeline: { ...fixture.timeline, tracks: [] } };
  useUIStore.setState({ selectedItems: [] });
  useProjectStore.setState({ hasOpenProject: true, project: { ...withNoTimelineClips, id: "old-project" } });
  useUIStore.setState({ selectedItems: [{ type: "clip", id: originalItem.id }] });
  await vi.waitFor(() => expect(profileCalls).toBeGreaterThan(0));

  const replacementItem = { ...originalItem, blob: new Blob(["replacement source"]) };
  useProjectStore.setState({
    hasOpenProject: true,
    project: {
      ...withNoTimelineClips,
      id: "replacement-project",
      mediaLibrary: { ...fixture.mediaLibrary, items: fixture.mediaLibrary.items.map((item) => item.id === originalItem.id ? replacementItem : item) },
    },
  });
  await vi.waitFor(() => expect(previewProxyCache.store.getState().entries[originalItem.id]?.status).toBe("ready"));
  const replacementBlob = previewProxyCache.resolve("replacement-project", replacementItem)?.blob;
  expect(replacementBlob?.size).toBeGreaterThan(0);

  rejectOldPreparation(new Error("old project preparation failed late"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(previewProxyCache.store.getState().entries[originalItem.id]?.status).toBe("ready");
  expect(previewProxyCache.resolve("replacement-project", replacementItem)?.blob).toBe(replacementBlob);
  delete window.licketysplit;
  useUIStore.setState({ selectedItems: [] });
});

it("preserves ready original preparation when thumbnail generation clones its media item", async () => {
  const { makeWorkflowFixture } = await import("@licketysplit/core/lickety/test-fixtures");
  const { useUIStore } = await import("./ui-store");
  const fixture = makeWorkflowFixture();
  const fixtureItem = fixture.mediaLibrary.items.find((candidate) => candidate.id === "cam-b")!;
  const item = { ...fixtureItem, blob: new Blob(["synthetic original"]) };
  const originalUri = vi.fn(async () => "licketysplit-media://cam-b/original");
  vi.spyOn(getMediaBridge(), "generateThumbnailsForMedia").mockResolvedValue([
    { timestamp: 0, dataUrl: "data:image/png;base64,c3ludGhldGlj" },
  ]);
  Object.assign(window, {
    licketysplit: {
      platform: "desktop",
      lickety: { originalUri, resourceProfile: async () => ({ lowMemory: false }) },
    },
  });
  const project = {
    ...fixture,
    timeline: { ...fixture.timeline, tracks: [] },
    mediaLibrary: { ...fixture.mediaLibrary, items: fixture.mediaLibrary.items.map((candidate) => candidate.id === item.id ? item : candidate) },
  };
  useUIStore.setState({ selectedItems: [] });
  useProjectStore.setState({ hasOpenProject: true, project });
  useUIStore.setState({ selectedItems: [{ type: "clip", id: item.id }] });

  await vi.waitFor(() => expect(useProjectStore.getState().getMediaItem(item.id)?.thumbnailUrl).toBe("data:image/png;base64,c3ludGhldGlj"));
  const thumbnailItem = useProjectStore.getState().getMediaItem(item.id)!;
  expect(thumbnailItem).not.toBe(item);
  expect(previewProxyCache.store.getState().entries[item.id]?.status).toBe("ready");
  expect(previewProxyCache.resolve(project.id, thumbnailItem)?.blob?.size).toBeGreaterThan(0);
  expect(originalUri).toHaveBeenCalledOnce();

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(previewProxyCache.store.getState().entries[item.id]?.status).toBe("ready");
  expect(originalUri).toHaveBeenCalledOnce();
  delete window.licketysplit;
  useUIStore.setState({ selectedItems: [] });
});

it("keeps an available original stable after optimization fails until explicit retry", async () => {
  const { makeWorkflowFixture } = await import("@licketysplit/core/lickety/test-fixtures");
  const { useUIStore } = await import("./ui-store");
  const fixture = makeWorkflowFixture();
  const source = fixture.mediaLibrary.items.find((item) => item.id === "cam-a")!;
  const item = { ...source, blob: new Blob(["source"]), thumbnailUrl: "fixture", metadata: { ...source.metadata, canDecodeVideo: true }, nativeSource: { identity: { assetId: "asset", mediaId: source.id, sha256: "sha", byteLength: 6 }, originalUri: "licketysplit-media://asset/original", durationMs: 20_000 } };
  const ensureProxy = vi.fn().mockRejectedValueOnce(new Error("preparation failed")).mockResolvedValue({ assetId: "asset", sourceSha256: "sha", proxyUri: "licketysplit-media://asset/proxy", version: 1, width: 960, height: 540, sourceStartPTS: 0, proxyStartPTS: 0, durationMs: 20_000 });
  Object.assign(window, { licketysplit: { platform: "desktop", lickety: { originalPreviewUri: async () => item.nativeSource.originalUri, resourceProfile: async () => ({ lowMemory: true }), resolve: async () => item.nativeSource.originalUri, ensureProxy, cancelMedia: async () => undefined } } });
  useTimelineStore.setState({ playbackState: "playing" });
  useUIStore.setState({ selectedItems: [{ type: "clip", id: item.id }] });
  useProjectStore.setState({ hasOpenProject: true, project: { ...fixture, timeline: { ...fixture.timeline, tracks: [] }, mediaLibrary: { ...fixture.mediaLibrary, items: [item] } } });
  await vi.waitFor(() => expect(previewProxyCache.store.getState().entries[item.id]?.status).toBe("error"));
  const revision = previewProxyCache.store.getState().revision;
  for (const position of [1, 2, 3]) { useTimelineStore.setState({ playheadPosition: position }); await Promise.resolve(); }
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(ensureProxy).toHaveBeenCalledOnce();
  expect(previewProxyCache.store.getState().revision).toBe(revision);
  expect(previewProxyCache.resolve(fixture.id, item).blob).toBe(item.blob);
  await retryNativePreviewPreparation(item.id);
  await vi.waitFor(() => expect(previewProxyCache.store.getState().entries[item.id]?.status).toBe("ready"));
  expect(ensureProxy).toHaveBeenCalledTimes(2);
  delete window.licketysplit;
  useUIStore.setState({ selectedItems: [] });
});
