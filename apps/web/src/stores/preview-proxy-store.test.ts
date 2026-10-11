import "../test/install-local-storage-mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaImportService, getMediaEngine, type MediaItem } from "@licketysplit/core";
import { createEmptyProject } from "./project/project-helpers";
import { useProjectStore } from "./project-store";
import { getMediaBridge } from "../bridges/media-bridge";
import { previewProxyCache, retryNativePreviewPreparation } from "./preview-proxy-store";

afterEach(() => {
  useProjectStore.setState({ hasOpenProject: false, project: createEmptyProject("Reset") });
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
it('desktop defers unused library identities until a current or selected clip needs preparation',async()=>{const {makeWorkflowFixture}=await import('@licketysplit/core/lickety/test-fixtures');const {useUIStore}=await import('./ui-store');const fixture=makeWorkflowFixture();const findAsset=vi.fn(async(mediaId:string)=>({identity:{assetId:mediaId,mediaId,sha256:'sha',byteLength:1},originalUri:`licketysplit-media://${mediaId}/original`,durationMs:20000}));Object.assign(window,{licketysplit:{platform:'desktop',lickety:{findAsset,originalUri:async(mediaId:string)=>`licketysplit-media://${mediaId}/original`,resourceProfile:async()=>({lowMemory:true}),resolve:async(id:string)=>`licketysplit-media://${id}/original`,ensureProxy:async(id:string)=>({assetId:id,sourceSha256:'sha',proxyUri:`licketysplit-media://${id}/proxy`,version:1,width:960,height:540,sourceStartPTS:0,proxyStartPTS:0,durationMs:20000})}}});useUIStore.setState({selectedItems:[]});useProjectStore.setState({hasOpenProject:true,project:{...fixture,timeline:{...fixture.timeline,tracks:[]}}});await new Promise(resolve=>setTimeout(resolve,20));expect(findAsset).not.toHaveBeenCalled();useUIStore.setState({selectedItems:[{type:'clip',id:'cam-b'}]});await vi.waitFor(()=>expect(findAsset).toHaveBeenCalledWith('cam-b'));expect(findAsset).not.toHaveBeenCalledWith('cam-a');await vi.waitFor(()=>expect(previewProxyCache.store.getState().entries['cam-b']?.status).toBe('ready'));delete window.licketysplit;useUIStore.setState({selectedItems:[]});});

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

  await vi.waitFor(() => expect(previewProxyCache.store.getState().entries[item.id]?.status).toBe("ready"));
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
  await vi.waitFor(() => expect(profileCalls).toBe(1));

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
